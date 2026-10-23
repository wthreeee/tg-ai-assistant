import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Один раздел базы знаний: вопрос (заголовок ##) и ответ */
export type KnowledgeSection = { title: string; body: string };

export type Knowledge = {
  /** Полный текст базы — уходит в системный промпт */
  text: string;
  sections: KnowledgeSection[];
  /** Хэш содержимого: если базу обновили, диалоги начинаются заново */
  hash: string;
};

/** Разбивает markdown на разделы по заголовкам второго уровня */
export function parseSections(markdown: string): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  let current: KnowledgeSection | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      if (current) sections.push(current);
      current = { title: heading[1].trim(), body: '' };
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ ...s, body: s.body.trim() })).filter((s) => s.body);
}

export function buildKnowledge(files: { name: string; content: string }[]): Knowledge {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  const text = sorted.map((f) => f.content.trim()).join('\n\n');
  return {
    text,
    sections: sorted.flatMap((f) => parseSections(f.content)),
    hash: createHash('sha256').update(text).digest('hex').slice(0, 12)
  };
}

/** Читает все .md из папки knowledge */
export function loadKnowledge(dir: string): Knowledge {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => ({ name, content: readFileSync(join(dir, name), 'utf8') }));
  if (files.length === 0) throw new Error(`В папке ${dir} нет .md файлов с базой знаний`);
  return buildKnowledge(files);
}
