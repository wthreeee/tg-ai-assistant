import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadKnowledge } from '../knowledge.ts';
import { createDemoAssistant } from './demo.ts';

const knowledge = loadKnowledge(new URL('../../knowledge', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const assistant = createDemoAssistant(knowledge);

describe('база знаний', () => {
  it('разбирает разделы-вопросы', () => {
    assert.ok(knowledge.sections.length >= 10);
    assert.ok(knowledge.sections.some((s) => s.title === 'Сколько стоят занятия?'));
    assert.equal(knowledge.hash.length, 12);
  });
});

describe('демо-ассистент', () => {
  it('находит ответ по смыслу вопроса', async () => {
    assert.match((await assistant.reply([], 'Сколько стоят ваши занятия?')).text, /1 900 ₽/);
    assert.match((await assistant.reply([], 'Сколько стоит урок?')).text, /1 900 ₽/);
    assert.match((await assistant.reply([], 'Кто преподаватели?')).text, /CELTA/);
    assert.match((await assistant.reply([], 'можно вернуть деньги за пакет?')).text, /возвращаем/);
  });

  it('просит контакты при записи и сохраняет заявку, когда они есть', async () => {
    assert.match((await assistant.reply([], 'Хочу записаться на пробный')).text, /имя и телефон/);
    const lead = await assistant.reply([], 'Меня зовут Анна, +7 900 123-45-67');
    assert.deepEqual(lead.actions[0], { type: 'lead', name: 'Анна', phone: '+7 900 123-45-67', request: 'Запись на пробный урок' });
  });

  it('передаёт менеджеру по просьбе клиента', async () => {
    const reply = await assistant.reply([], 'Позовите менеджера');
    assert.equal(reply.actions[0].type, 'handoff');
  });

  it('честно говорит, если ответа нет', async () => {
    assert.match((await assistant.reply([], 'Какая погода на Марсе?')).text, /Не нашёл/);
  });
});
