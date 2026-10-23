import Fastify from 'fastify';

import type { ChatService } from './chat-service.ts';

/**
 * Чат на сайте: тот же ассистент, что и в Telegram. Страницу можно открыть напрямую
 * или встроить на сайт клиента через <iframe src="https://…/">.
 */
export function createWebChat(options: { chat: ChatService; businessName: string; mode: 'claude' | 'demo' }) {
  const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 16 * 1024 });

  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(page(options.businessName, options.mode)));

  app.post<{ Body: { sessionId?: unknown; text?: unknown; name?: unknown } }>('/api/chat', async (request, reply) => {
    const { sessionId, text } = request.body ?? {};
    if (typeof sessionId !== 'string' || !/^[a-z0-9-]{8,64}$/i.test(sessionId) || typeof text !== 'string' || !text.trim()) {
      return reply.code(400).send({ error: 'Некорректный запрос' });
    }
    const result = await options.chat.handleMessage(`web:${sessionId}`, '', text.trim());
    if (result.kind === 'forward') {
      return { reply: 'Сообщение передано менеджеру. Он свяжется с вами по оставленным контактам.' };
    }
    return { reply: result.text, handoff: result.kind === 'reply' && result.actions.some((a) => a.type === 'handoff') };
  });

  return app;
}

function page(businessName: string, mode: 'claude' | 'demo'): string {
  // Название вставляется и в HTML, и в строку JS — убираем символы, которые могут их сломать
  const name = businessName.replace(/[<>&"'`\\$]/g, '');
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — консультант</title>
<style>
  :root { --bg: #f4f5f7; --panel: #fff; --text: #17191c; --hint: #7a808a; --accent: #2457d6; --accent-text: #fff; --bubble: #eceff4; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111317; --panel: #1a1d22; --text: #eef0f3; --hint: #8c929c; --accent: #6d8dff; --accent-text: #0d1020; --bubble: #262a31; } }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { height: 100%; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 15px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; }
  .chat { width: 100%; max-width: 480px; height: 100%; display: flex; flex-direction: column; background: var(--panel); }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--bubble); }
  .avatar { width: 40px; height: 40px; border-radius: 50%; background: var(--accent); color: var(--accent-text); display: grid; place-items: center; font-weight: 700; }
  header b { display: block; }
  header span { color: var(--hint); font-size: 13px; }
  .badge { margin-left: auto; font-size: 11px; padding: 3px 8px; border-radius: 999px; background: var(--bubble); color: var(--hint); }
  .log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  .msg { max-width: 85%; padding: 9px 13px; border-radius: 16px; white-space: pre-wrap; word-wrap: break-word; }
  .bot { align-self: flex-start; background: var(--bubble); border-bottom-left-radius: 4px; }
  .me { align-self: flex-end; background: var(--accent); color: var(--accent-text); border-bottom-right-radius: 4px; }
  .typing { color: var(--hint); font-size: 13px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 16px 10px; }
  .chips button { border: 1px solid var(--bubble); background: none; color: var(--accent); border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; }
  form { display: flex; gap: 8px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--bubble); }
  input { flex: 1; min-width: 0; padding: 11px 14px; border-radius: 999px; border: 0; background: var(--bubble); color: var(--text); font: inherit; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  form button { width: 44px; border: 0; border-radius: 50%; background: var(--accent); color: var(--accent-text); font-size: 18px; cursor: pointer; }
  form button:disabled { opacity: .5; }
</style>
</head>
<body>
<main class="chat">
  <header>
    <div class="avatar">${name.slice(0, 1).toUpperCase()}</div>
    <div><b>${name}</b><span>Онлайн-консультант</span></div>
    ${mode === 'demo' ? '<span class="badge">демо-режим без ИИ</span>' : ''}
  </header>
  <div class="log" id="log" aria-live="polite"></div>
  <div class="chips" id="chips">
    <button type="button">Сколько стоит урок?</button>
    <button type="button">Есть пробный урок?</button>
    <button type="button">Какие скидки?</button>
  </div>
  <form id="form">
    <input id="text" autocomplete="off" placeholder="Напишите вопрос…" maxlength="1000" aria-label="Сообщение">
    <button id="send" aria-label="Отправить">➤</button>
  </form>
</main>
<script>
  const log = document.getElementById('log');
  const form = document.getElementById('form');
  const input = document.getElementById('text');
  const send = document.getElementById('send');
  let sessionId;
  try { sessionId = localStorage.getItem('chatSession'); } catch {}
  if (!sessionId) { sessionId = crypto.randomUUID(); try { localStorage.setItem('chatSession', sessionId); } catch {} }

  function add(text, who) {
    const el = document.createElement('div');
    el.className = 'msg ' + who;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  add('Здравствуйте! Я консультант школы «${name}». Спросите о форматах, ценах или запишитесь на бесплатный пробный урок.', 'bot');

  async function ask(text) {
    add(text, 'me');
    document.getElementById('chips').hidden = true;
    send.disabled = true;
    const typing = add('печатает…', 'bot typing');
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, text }) });
      const data = await res.json();
      typing.remove();
      add(data.reply || data.error || 'Не получилось ответить, попробуйте ещё раз.', 'bot');
    } catch {
      typing.remove();
      add('Нет соединения. Попробуйте ещё раз.', 'bot');
    } finally {
      send.disabled = false;
      input.focus();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    ask(text);
  });
  document.querySelectorAll('#chips button').forEach((b) => b.addEventListener('click', () => ask(b.textContent)));
</script>
</body>
</html>`;
}
