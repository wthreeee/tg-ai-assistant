import Anthropic from '@anthropic-ai/sdk';

import type { Assistant, AssistantAction, AssistantReply, StoredMessage } from './types.ts';

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type CreateMessage = (params: CreateParams) => Promise<Anthropic.Beta.Messages.BetaMessage>;

/** Защита от зацикливания: сколько раз подряд модель может вызвать инструменты в одном ответе */
const MAX_TOOL_ROUNDS = 4;

const REFUSAL_TEXT = 'С этим вопросом я помочь не могу. Если хотите, передам диалог менеджеру — просто напишите «менеджер».';

const tools: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: 'save_lead',
    description:
      'Сохраняет заявку клиента (запись на пробный урок, обратный звонок, консультация). Вызывай, только когда клиент сам назвал имя и телефон.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Имя клиента, как он представился' },
        phone: { type: 'string', description: 'Телефон клиента, как он его написал' },
        request: { type: 'string', description: 'Что хочет клиент, одной фразой' }
      },
      required: ['name', 'phone', 'request'],
      additionalProperties: false
    }
  },
  {
    name: 'handoff_to_manager',
    description:
      'Передаёт диалог живому менеджеру. Бот после этого замолкает, пока менеджер не вернёт диалог.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Почему нужен менеджер' },
        summary: { type: 'string', description: 'Краткое содержание диалога для менеджера: кто клиент и что ему нужно' }
      },
      required: ['reason', 'summary'],
      additionalProperties: false
    }
  }
];

type Options = {
  systemPrompt: string;
  model: string;
  /** Для тестов можно подставить свою функцию вместо настоящего API */
  createMessage?: CreateMessage;
  apiKey?: string;
};

export function createClaudeAssistant(options: Options): Assistant {
  const createMessage: CreateMessage =
    options.createMessage ??
    (() => {
      const client = new Anthropic({ apiKey: options.apiKey });
      return (params: CreateParams) => client.beta.messages.create(params);
    })();

  function runTool(block: Anthropic.Beta.Messages.BetaToolUseBlock): {
    action: AssistantAction | null;
    result: string;
  } {
    const input = block.input as Record<string, unknown>;
    const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string).trim() : '');

    if (block.name === 'save_lead') {
      const lead = { type: 'lead' as const, name: str('name'), phone: str('phone'), request: str('request') };
      if (!lead.name || !lead.phone) return { action: null, result: 'Ошибка: нужны имя и телефон клиента.' };
      return { action: lead, result: 'Заявка сохранена. Менеджер свяжется с клиентом в рабочее время.' };
    }
    if (block.name === 'handoff_to_manager') {
      return {
        action: { type: 'handoff', reason: str('reason'), summary: str('summary') },
        result: 'Диалог передан менеджеру. Скажи клиенту, что менеджер скоро ответит в этом же чате.'
      };
    }
    return { action: null, result: `Неизвестный инструмент ${block.name}` };
  }

  async function reply(history: StoredMessage[], userText: string): Promise<AssistantReply> {
    const newMessages: StoredMessage[] = [{ role: 'user', content: userText }];
    const actions: AssistantAction[] = [];

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await createMessage({
        model: options.model,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        // Если классификатор безопасности отклонит запрос, API сам повторит его на подходящей модели
        fallbacks: 'default',
        // Консультации — простая задача: низкое усилие экономит токены и время ответа
        output_config: { effort: 'low' },
        // Кэшируем всё до последнего блока: системный промпт с базой знаний и историю диалога
        cache_control: { type: 'ephemeral' },
        system: options.systemPrompt,
        tools,
        messages: [...history, ...newMessages] as Anthropic.Beta.Messages.BetaMessageParam[]
      });

      if (response.stop_reason === 'refusal') {
        // Отклонённый ответ в историю не пишем; сообщение клиента остаётся
        return { text: REFUSAL_TEXT, actions, newMessages };
      }

      // Ответ модели дописываем целиком, со всеми блоками (thinking в том числе)
      newMessages.push({ role: 'assistant', content: response.content });

      const text = response.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      if (response.stop_reason !== 'tool_use') {
        return { text: text || 'Уточните, пожалуйста, вопрос.', actions, newMessages };
      }

      const toolResults: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const { action, result } = runTool(block);
        if (action) actions.push(action);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result, is_error: !action });
      }
      // Все результаты инструментов — одним сообщением
      newMessages.push({ role: 'user', content: toolResults });
    }

    return { text: 'Секунду, уточняю информацию. Если ответ не придёт, напишите «менеджер».', actions, newMessages };
  }

  return { mode: 'claude', reply };
}
