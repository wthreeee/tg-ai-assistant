import type { Knowledge, KnowledgeSection } from '../knowledge.ts';
import type { Assistant, AssistantReply, StoredMessage } from './types.ts';

/**
 * Демо-режим без ИИ: ищет в базе знаний раздел с наибольшим совпадением слов.
 * Нужен, чтобы запустить и показать проект без ключа API. С ключом работает Claude.
 */

const STOP_WORDS = new Set(['как', 'что', 'это', 'для', 'или', 'есть', 'ли', 'можно', 'вас', 'нас', 'мне', 'какие', 'какой', 'сколько', 'где']);

/** Грубая нормализация: нижний регистр, без знаков, корень слова — первые 5 букв */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map((w) => w.slice(0, 5));
}

/** Частые формулировки, которые плохо ловятся по словам («стоит» ≠ «стоят»): тема → заголовок раздела */
const INTENTS: { question: RegExp; title: RegExp }[] = [
  { question: /сто[иья]т|цен[аыу]|прайс|почём|почем|стоимост/i, title: /стоят|цен/i },
  { question: /скидк|акци|дешевл/i, title: /скидк/i },
  { question: /вернуть|возврат/i, title: /вернуть/i },
  { question: /перенес|отмен/i, title: /перенести/i }
];

export function findBestSection(sections: KnowledgeSection[], question: string): KnowledgeSection | null {
  const intent = INTENTS.find((i) => i.question.test(question));
  const byIntent = intent && sections.find((s) => intent.title.test(s.title));
  if (byIntent) return byIntent;

  const words = new Set(tokenize(question));
  let best: KnowledgeSection | null = null;
  let bestScore = 0;
  for (const section of sections) {
    const titleWords = tokenize(section.title);
    const bodyWords = new Set(tokenize(section.body));
    // Совпадение с заголовком-вопросом весит больше, чем с текстом ответа
    const score =
      titleWords.filter((w) => words.has(w)).length * 3 + [...bodyWords].filter((w) => words.has(w)).length;
    if (score > bestScore) {
      best = section;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : null;
}

const PHONE_RE = /(\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/;
// «Меня зовут Анна» или «Я — Анна»; имя с заглавной буквы
const NAME_RE = /(?:[Мм]еня зовут|(?:^|[\s,.!])[Яя])\s*[-—–]?\s*([А-ЯЁ][а-яё]+)/;

export function createDemoAssistant(knowledge: Knowledge): Assistant {
  async function reply(history: StoredMessage[], userText: string): Promise<AssistantReply> {
    const lower = userText.toLowerCase();
    const newMessages: StoredMessage[] = [{ role: 'user', content: userText }];
    const answer = (text: string, actions: AssistantReply['actions'] = []): AssistantReply => {
      newMessages.push({ role: 'assistant', content: text });
      return { text, actions, newMessages };
    };

    if (/менеджер|оператор|человек|живой|жалоб/.test(lower)) {
      const summary = history
        .filter((m) => m.role === 'user' && typeof m.content === 'string')
        .map((m) => m.content as string)
        .concat(userText)
        .slice(-3)
        .join(' / ');
      return answer('Передаю диалог менеджеру — он ответит здесь же в рабочее время.', [
        { type: 'handoff', reason: 'Клиент попросил менеджера', summary }
      ]);
    }

    const phone = PHONE_RE.exec(userText)?.[0];
    if (phone) {
      const name = NAME_RE.exec(userText)?.[1] ?? 'не указано';
      return answer(`Спасибо! Записал заявку: ${name}, ${phone}. Менеджер перезвонит в рабочее время и подберёт время пробного урока.`, [
        { type: 'lead', name, phone, request: 'Запись на пробный урок' }
      ]);
    }

    if (/запис|пробн|хочу заниматься|оставить заявк|перезвон/.test(lower)) {
      const trial = knowledge.sections.find((s) => /пробн/i.test(s.title));
      return answer(
        `${trial ? `${trial.body}\n\n` : ''}Чтобы записаться, напишите, пожалуйста, ваше имя и телефон — например: «Меня зовут Анна, +7 900 123-45-67».`
      );
    }

    const section = findBestSection(knowledge.sections, userText);
    if (section) return answer(section.body);

    return answer('Не нашёл ответа на этот вопрос в нашей базе. Могу передать диалог менеджеру — напишите «менеджер».');
  }

  return { mode: 'demo', reply };
}
