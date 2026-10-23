export const config = {
  /** Токен Telegram-бота. Без него работает только чат на сайте */
  botToken: process.env.BOT_TOKEN?.trim() || null,
  /** Ключ Claude API. Без него ассистент работает в демо-режиме (поиск по базе знаний) */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || null,
  model: process.env.CLAUDE_MODEL?.trim() || 'claude-opus-5-5',
  /** Telegram ID менеджеров: им приходят заявки и диалоги, переданные человеку */
  adminIds: (process.env.ADMIN_IDS ?? '')
    .split(',')
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isInteger(id) && id > 0),
  businessName: process.env.BUSINESS_NAME ?? 'Speak Up',
  knowledgeDir: process.env.KNOWLEDGE_DIR ?? 'knowledge',
  dbPath: process.env.DB_PATH ?? 'data/assistant.db',
  port: Number(process.env.PORT ?? 3000),
  telegramProxy: process.env.TELEGRAM_PROXY?.trim() || null
};
