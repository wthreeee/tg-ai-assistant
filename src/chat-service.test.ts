import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import type { Assistant, AssistantReply } from './assistant/types.ts';
import { LIMITS, createChatService, type ChatEvent } from './chat-service.ts';
import { openDatabase, type Database } from './db.ts';

const HOUR = 60 * 60 * 1000;

/** Ассистент-заглушка: отвечает эхом, а на «заявка»/«менеджер» возвращает действие */
const echoAssistant: Assistant = {
  mode: 'demo',
  async reply(history, userText): Promise<AssistantReply> {
    const actions: AssistantReply['actions'] = [];
    if (userText === 'заявка') actions.push({ type: 'lead', name: 'Анна', phone: '+79001234567', request: 'Пробный' });
    if (userText === 'менеджер') actions.push({ type: 'handoff', reason: 'просьба', summary: 'хочет человека' });
    const text = `эхо ${history.length}: ${userText}`;
    return { text, actions, newMessages: [{ role: 'user', content: userText }, { role: 'assistant', content: text }] };
  }
};

let db: Database;
let clock: number;
let events: ChatEvent[];

const service = (kbHash = 'v1') => {
  const chat = createChatService({ db, assistant: echoAssistant, kbHash, now: () => clock });
  chat.onEvent((e) => events.push(e));
  return chat;
};

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = Date.UTC(2026, 9, 23, 10);
  events = [];
});

describe('chat-service', () => {
  it('ведёт историю диалога', async () => {
    const chat = service();
    await chat.handleMessage('tg:1', 'Иван', 'привет');
    const second = await chat.handleMessage('tg:1', 'Иван', 'ещё');
    assert.deepEqual(second, { kind: 'reply', text: 'эхо 2: ещё', actions: [] });
  });

  it('начинает новый диалог после долгой паузы и после обновления базы знаний', async () => {
    await service('v1').handleMessage('tg:1', 'Иван', 'привет');
    clock += 25 * HOUR;
    const afterIdle = await service('v1').handleMessage('tg:1', 'Иван', 'снова');
    assert.equal(afterIdle.kind === 'reply' && afterIdle.text, 'эхо 0: снова');

    const afterKbUpdate = await service('v2').handleMessage('tg:1', 'Иван', 'новая база');
    assert.equal(afterKbUpdate.kind === 'reply' && afterKbUpdate.text, 'эхо 0: новая база');
  });

  it('сохраняет заявку и сообщает о ней', async () => {
    await service().handleMessage('tg:1', 'Иван', 'заявка');
    assert.equal(db.recentLeads()[0].phone, '+79001234567');
    assert.equal(events[0].type, 'lead');
  });

  it('после передачи менеджеру молчит и пересылает сообщения, пока диалог не вернут', async () => {
    const chat = service();
    await chat.handleMessage('tg:1', 'Иван', 'менеджер');
    assert.equal(events[0].type, 'handoff');
    assert.deepEqual(await chat.handleMessage('tg:1', 'Иван', 'алло?'), { kind: 'forward' });

    chat.releaseToAssistant('tg:1');
    const after = await chat.handleMessage('tg:1', 'Иван', 'вопрос');
    assert.equal(after.kind, 'reply');
  });

  it('ограничивает число сообщений в час', async () => {
    const chat = service();
    for (let i = 0; i < LIMITS.messagesPerHour; i++) await chat.handleMessage('tg:1', 'Иван', `вопрос ${i}`);
    assert.equal((await chat.handleMessage('tg:1', 'Иван', 'ещё')).kind, 'limited');
    clock += HOUR + 1;
    assert.equal((await chat.handleMessage('tg:1', 'Иван', 'через час')).kind, 'reply');
  });
});
