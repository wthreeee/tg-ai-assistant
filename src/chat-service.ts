import type { Assistant, AssistantAction } from './assistant/types.ts';
import type { Database } from './db.ts';

const HOUR = 60 * 60 * 1000;

/** Лимиты, которые держат расходы на ИИ под контролем */
export const LIMITS = {
  /** Сообщений от одного клиента в час */
  messagesPerHour: 20,
  /** После стольких сообщений диалог начинается заново, чтобы история не разрасталась */
  maxMessagesPerConversation: 60,
  /** Через сколько часов тишины диалог начинается заново */
  idleHours: 24
};

export type ChatResult =
  /** Ответ ассистента клиенту */
  | { kind: 'reply'; text: string; actions: AssistantAction[] }
  /** Диалог у менеджера: сообщение нужно переслать ему, ассистент молчит */
  | { kind: 'forward' }
  | { kind: 'limited'; text: string };

export type ChatEvent =
  | { type: 'lead'; clientKey: string; clientName: string; name: string; phone: string; request: string }
  | { type: 'handoff'; clientKey: string; clientName: string; reason: string; summary: string };

export function createChatService(options: {
  db: Database;
  assistant: Assistant;
  kbHash: string;
  now?: () => number;
}) {
  const { db, assistant } = options;
  const now = options.now ?? Date.now;
  const listeners: ((event: ChatEvent) => void)[] = [];

  /**
   * Текущий диалог клиента или новый. Историю никогда не редактируем: если её пора «обрезать»
   * или база знаний изменилась, просто начинаем новый диалог.
   */
  function currentConversation(clientKey: string, clientName: string) {
    const existing = db.openConversation(clientKey);
    if (existing) {
      const idle = now() - existing.lastAt > LIMITS.idleHours * HOUR;
      const outdated =
        existing.kbHash !== options.kbHash || db.countMessages(existing.id) >= LIMITS.maxMessagesPerConversation;
      // Диалог у менеджера не закрываем из-за объёма или новой базы — только после долгой тишины
      if (!idle && (!outdated || existing.handedOff)) return existing;
      db.closeConversation(existing.id);
    }

    db.createConversation(clientKey, clientName, options.kbHash, now());
    return db.openConversation(clientKey)!;
  }

  async function handleMessage(clientKey: string, clientName: string, text: string): Promise<ChatResult> {
    const conversation = currentConversation(clientKey, clientName);
    db.touchConversation(conversation.id, now());

    if (conversation.handedOff) {
      db.appendMessages(conversation.id, [{ role: 'user', content: text }], now());
      return { kind: 'forward' };
    }

    if (db.countClientMessagesSince(clientKey, now() - HOUR) >= LIMITS.messagesPerHour) {
      return { kind: 'limited', text: 'Слишком много сообщений подряд. Напишите чуть позже или попросите «менеджер».' };
    }

    const reply = await assistant.reply(db.history(conversation.id), text.slice(0, 2000));
    db.appendMessages(conversation.id, reply.newMessages, now());

    for (const action of reply.actions) {
      if (action.type === 'lead') {
        db.saveLead({ clientKey, name: action.name, phone: action.phone, request: action.request, createdAt: now() });
        emit({ type: 'lead', clientKey, clientName, name: action.name, phone: action.phone, request: action.request });
      } else {
        db.setHandedOff(conversation.id, true);
        emit({ type: 'handoff', clientKey, clientName, reason: action.reason, summary: action.summary });
      }
    }

    return { kind: 'reply', text: reply.text, actions: reply.actions };
  }

  /** Менеджер закончил: дальше снова отвечает ассистент, с чистого диалога */
  function releaseToAssistant(clientKey: string) {
    const conversation = db.openConversation(clientKey);
    if (conversation) db.closeConversation(conversation.id);
  }

  function resetConversation(clientKey: string) {
    const conversation = db.openConversation(clientKey);
    if (conversation) db.closeConversation(conversation.id);
  }

  function emit(event: ChatEvent) {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Ошибка обработчика события чата:', error);
      }
    }
  }

  return {
    handleMessage,
    releaseToAssistant,
    resetConversation,
    onEvent: (listener: (event: ChatEvent) => void) => listeners.push(listener)
  };
}

export type ChatService = ReturnType<typeof createChatService>;
