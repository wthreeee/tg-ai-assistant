/** Что ассистент решил сделать помимо ответа */
export type AssistantAction =
  | { type: 'lead'; name: string; phone: string; request: string }
  | { type: 'handoff'; reason: string; summary: string };

/**
 * Сообщение истории в том виде, в каком его хранит и отправляет ассистент.
 * Для Claude content — это блоки ответа API (включая thinking), их нельзя менять,
 * поэтому история только дописывается.
 */
export type StoredMessage = { role: 'user' | 'assistant'; content: unknown };

export type AssistantReply = {
  /** Текст для клиента */
  text: string;
  actions: AssistantAction[];
  /** Новые сообщения, которые нужно дописать в историю диалога */
  newMessages: StoredMessage[];
};

export interface Assistant {
  readonly mode: 'claude' | 'demo';
  reply(history: StoredMessage[], userText: string): Promise<AssistantReply>;
}
