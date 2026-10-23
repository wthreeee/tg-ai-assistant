import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';

import { createClaudeAssistant } from './claude.ts';

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

/** Подменяет API: отдаёт заранее заготовленные ответы и запоминает запросы */
function fakeApi(responses: Partial<Message>[]) {
  const calls: Params[] = [];
  const createMessage = async (params: Params) => {
    calls.push(structuredClone(params));
    const next = responses.shift();
    if (!next) throw new Error('Неожиданный лишний запрос к API');
    return { id: 'msg', type: 'message', role: 'assistant', model: params.model, ...next } as Message;
  };
  return { calls, createMessage };
}

const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Anthropic.Beta.Messages.BetaTextBlock;
const thinking = { type: 'thinking', thinking: '', signature: 'sig' } as Anthropic.Beta.Messages.BetaThinkingBlock;

describe('Claude-ассистент', () => {
  it('отправляет вопрос с системным промптом, кэшем и fallback и возвращает текст', async () => {
    const api = fakeApi([{ stop_reason: 'end_turn', content: [thinking, text('Индивидуальный урок — 1 900 ₽.')] }]);
    const assistant = createClaudeAssistant({ systemPrompt: 'SYSTEM', model: 'claude-opus-5-5', createMessage: api.createMessage });

    const reply = await assistant.reply([], 'Сколько стоит урок?');

    assert.equal(reply.text, 'Индивидуальный урок — 1 900 ₽.');
    const request = api.calls[0];
    assert.equal(request.system, 'SYSTEM');
    assert.equal(request.fallbacks, 'default');
    assert.deepEqual(request.cache_control, { type: 'ephemeral' });
    // Ответ модели сохраняется целиком, вместе с thinking-блоком
    assert.deepEqual(reply.newMessages[1], { role: 'assistant', content: [thinking, text('Индивидуальный урок — 1 900 ₽.')] });
  });

  it('выполняет save_lead и продолжает диалог с результатом инструмента', async () => {
    const api = fakeApi([
      {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'save_lead',
            input: { name: 'Анна', phone: '+79001234567', request: 'Пробный урок' }
          } as Anthropic.Beta.Messages.BetaToolUseBlock
        ]
      },
      { stop_reason: 'end_turn', content: [text('Готово, Анна! Менеджер позвонит сегодня.')] }
    ]);
    const assistant = createClaudeAssistant({ systemPrompt: 'S', model: 'm', createMessage: api.createMessage });

    const reply = await assistant.reply([], 'Анна, +7 900 123-45-67');

    assert.deepEqual(reply.actions, [{ type: 'lead', name: 'Анна', phone: '+79001234567', request: 'Пробный урок' }]);
    assert.equal(reply.text, 'Готово, Анна! Менеджер позвонит сегодня.');
    // Второй запрос продолжает историю: вопрос, вызов инструмента, его результат
    const second = api.calls[1].messages;
    assert.equal(second.length, 3);
    const toolResult = (second[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[])[0];
    assert.equal(toolResult.tool_use_id, 'tool_1');
    assert.equal(reply.newMessages.length, 4);
  });

  it('передаёт прошлую историю без изменений', async () => {
    const history = [
      { role: 'user' as const, content: 'Привет' },
      { role: 'assistant' as const, content: [thinking, text('Здравствуйте!')] }
    ];
    const api = fakeApi([{ stop_reason: 'end_turn', content: [text('Ок')] }]);
    const assistant = createClaudeAssistant({ systemPrompt: 'S', model: 'm', createMessage: api.createMessage });

    await assistant.reply(history, 'Вопрос');

    assert.deepEqual(api.calls[0].messages.slice(0, 2), history);
  });

  it('на отказ отвечает вежливо и не пишет пустой ответ в историю', async () => {
    const api = fakeApi([{ stop_reason: 'refusal', content: [] }]);
    const assistant = createClaudeAssistant({ systemPrompt: 'S', model: 'm', createMessage: api.createMessage });

    const reply = await assistant.reply([], '...');

    assert.match(reply.text, /менеджер/);
    assert.deepEqual(reply.newMessages, [{ role: 'user', content: '...' }]);
  });
});
