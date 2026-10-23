import { config } from './config.ts';
import { createClaudeAssistant } from './assistant/claude.ts';
import { createDemoAssistant } from './assistant/demo.ts';
import { buildSystemPrompt } from './assistant/prompt.ts';
import type { Assistant } from './assistant/types.ts';
import { createBot } from './bot.ts';
import { createChatService } from './chat-service.ts';
import { openDatabase } from './db.ts';
import { loadKnowledge } from './knowledge.ts';
import { createWebChat } from './web-chat.ts';

const knowledge = loadKnowledge(config.knowledgeDir);
const db = openDatabase(config.dbPath);

const assistant: Assistant = config.anthropicApiKey
  ? createClaudeAssistant({
      apiKey: config.anthropicApiKey,
      model: config.model,
      systemPrompt: buildSystemPrompt(config.businessName, knowledge)
    })
  : createDemoAssistant(knowledge);

const chat = createChatService({ db, assistant, kbHash: knowledge.hash });

const web = createWebChat({ chat, businessName: config.businessName, mode: assistant.mode });
await web.listen({ port: config.port, host: '0.0.0.0' });

console.log(`База знаний: ${knowledge.sections.length} разделов (версия ${knowledge.hash})`);
console.log(
  assistant.mode === 'claude'
    ? `Ассистент: Claude (${config.model})`
    : 'Ассистент: демо-режим без ИИ. Чтобы подключить Claude, укажите ANTHROPIC_API_KEY'
);
console.log(`Чат для сайта: http://localhost:${config.port}`);

if (config.botToken) {
  const { bot, setup } = createBot({
    token: config.botToken,
    db,
    chat,
    adminIds: config.adminIds,
    businessName: config.businessName,
    proxyUrl: config.telegramProxy
  });
  await setup();
  void bot.start({ onStart: (info) => console.log(`Бот @${info.username} запущен`) });
  if (config.adminIds.length === 0) console.log('⚠️  ADMIN_IDS не задан — заявки никому не приходят. Узнать свой ID: /myid');
} else {
  console.log('BOT_TOKEN не задан — работает только чат для сайта');
}

const shutdown = async () => {
  await web.close();
  db.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
