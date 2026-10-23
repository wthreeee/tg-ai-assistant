import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';

import type { ChatEvent, ChatService } from './chat-service.ts';
import type { Database } from './db.ts';

type BotOptions = {
  token: string;
  db: Database;
  chat: ChatService;
  adminIds: number[];
  businessName: string;
  proxyUrl: string | null;
};

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clientLabel = (key: string, name: string) =>
  key.startsWith('web:') ? `${name || 'Посетитель сайта'} (чат на сайте)` : `${name} (Telegram)`;

export function createBot(options: BotOptions) {
  const { db, chat, adminIds } = options;
  const bot = new Bot(options.token, {
    client: options.proxyUrl ? { baseFetchConfig: { agent: new HttpsProxyAgent(options.proxyUrl) } } : undefined
  });
  const isAdmin = (ctx: Context) => Boolean(ctx.from && adminIds.includes(ctx.from.id));

  /** Отправляет сообщение всем менеджерам и запоминает, к какому клиенту оно относится */
  async function notifyAdmins(clientKey: string, html: string, keyboard?: InlineKeyboard) {
    for (const adminId of adminIds) {
      try {
        const sent = await bot.api.sendMessage(adminId, html, { parse_mode: 'HTML', reply_markup: keyboard });
        db.rememberThread(adminId, sent.message_id, clientKey);
      } catch (error) {
        console.warn(`Не удалось отправить сообщение менеджеру ${adminId}:`, (error as Error).message);
      }
    }
  }

  chat.onEvent((event: ChatEvent) => {
    const who = escapeHtml(clientLabel(event.clientKey, event.clientName));
    if (event.type === 'lead') {
      void notifyAdmins(
        event.clientKey,
        `🎯 <b>Новая заявка</b>\n\n👤 ${escapeHtml(event.name)}\n📞 ${escapeHtml(event.phone)}\n📝 ${escapeHtml(event.request)}\n\nИсточник: ${who}`
      );
    } else {
      const canReply = event.clientKey.startsWith('tg:');
      void notifyAdmins(
        event.clientKey,
        [
          `🙋 <b>Клиенту нужен менеджер</b>`,
          `Клиент: ${who}`,
          `Причина: ${escapeHtml(event.reason)}`,
          `Суть: ${escapeHtml(event.summary)}`,
          '',
          canReply
            ? 'Ответьте на это сообщение (Reply) — ответ уйдёт клиенту. Бот молчит, пока вы не вернёте диалог.'
            : 'Клиент пишет с сайта: свяжитесь с ним по контактам из заявки.'
        ].join('\n'),
        new InlineKeyboard().text('🤖 Вернуть диалог боту', `release:${event.clientKey}`)
      );
    }
  });

  bot.command('start', (ctx) =>
    ctx.reply(
      [
        `Здравствуйте! Я онлайн-консультант школы «${options.businessName}» 👋`,
        '',
        'Расскажу о форматах занятий, ценах и скидках, запишу на бесплатный пробный урок.',
        'Например, спросите: «Сколько стоит урок?» или «Как записаться на пробный?»',
        '',
        'Если нужен живой человек — напишите «менеджер».'
      ].join('\n')
    )
  );

  bot.command('new', async (ctx) => {
    chat.resetConversation(`tg:${ctx.from!.id}`);
    await ctx.reply('Начинаем разговор заново. Чем могу помочь?');
  });

  bot.command('myid', (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from?.id}`));

  bot.command('leads', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Команда доступна только менеджеру.');
    const leads = db.recentLeads(10);
    if (leads.length === 0) return ctx.reply('Заявок пока нет.');
    const lines = leads.map(
      (l) => `• ${new Date(l.createdAt).toLocaleString('ru-RU')} — ${escapeHtml(l.name)}, ${escapeHtml(l.phone)}: ${escapeHtml(l.request)}`
    );
    await ctx.reply(`🎯 <b>Последние заявки</b>\n\n${lines.join('\n')}`, { parse_mode: 'HTML' });
  });

  bot.callbackQuery(/^release:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery('Только для менеджера');
    const clientKey = ctx.match[1];
    chat.releaseToAssistant(clientKey);
    await ctx.answerCallbackQuery('Диалог возвращён боту');
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    if (clientKey.startsWith('tg:')) {
      await bot.api
        .sendMessage(Number(clientKey.slice(3)), 'Менеджер завершил диалог. Если появятся вопросы — я на связи 🙂')
        .catch(() => {});
    }
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;

    // Менеджер отвечает клиенту реплаем на уведомление
    const repliedTo = ctx.message.reply_to_message;
    if (isAdmin(ctx) && repliedTo) {
      const clientKey = db.threadClient(ctx.chat.id, repliedTo.message_id);
      if (clientKey?.startsWith('tg:')) {
        await bot.api.sendMessage(Number(clientKey.slice(3)), `👩‍💼 Менеджер: ${text}`);
        await ctx.react('👍').catch(() => {});
        return;
      }
      if (clientKey) return ctx.reply('Этот клиент писал с сайта — ответить в Telegram не получится. Свяжитесь по телефону из заявки.');
    }

    const clientKey = `tg:${ctx.from.id}`;
    const clientName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') + (ctx.from.username ? ` @${ctx.from.username}` : '');

    await ctx.replyWithChatAction('typing').catch(() => {});
    try {
      const result = await chat.handleMessage(clientKey, clientName, text);
      if (result.kind === 'forward') {
        await notifyAdmins(clientKey, `💬 <b>${escapeHtml(clientName)}</b>:\n${escapeHtml(text)}\n\n<i>Ответьте реплаем, чтобы написать клиенту</i>`);
        return;
      }
      await ctx.reply(result.text);
    } catch (error) {
      console.error('Ошибка ассистента:', error);
      await ctx.reply('Не получилось ответить, попробуйте ещё раз через минуту или напишите «менеджер».');
    }
  });

  bot.catch(({ error, ctx }) => {
    const description = error instanceof GrammyError ? error.description : String(error);
    console.error(`Ошибка при обработке update ${ctx.update.update_id}:`, description);
  });

  async function setup() {
    await bot.api.setMyCommands([
      { command: 'start', description: 'Что умеет консультант' },
      { command: 'new', description: 'Начать разговор заново' }
    ]);
    for (const chatId of adminIds) {
      await bot.api
        .setMyCommands(
          [
            { command: 'leads', description: 'Последние заявки' },
            { command: 'new', description: 'Начать разговор заново' }
          ],
          { scope: { type: 'chat', chat_id: chatId } }
        )
        .catch(() => console.warn(`Менеджер ${chatId} ещё не запускал бота — команды появятся позже`));
    }
  }

  return { bot, setup };
}
