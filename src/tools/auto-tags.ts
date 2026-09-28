/**
 * Детерминированный вывод tool-тегов по типу задачи (P5 auto-narrowing).
 *
 * Главный цикл показывает LLM только `defaultTags` (+ структурные `alwaysOn`);
 * остальное скрыто за `enable_tools`. Без preseed веб-задача тратит первый ход
 * на поиск `enable_tools`, а 9B-модель иногда уходит в shell/MCP (из-за этого
 * сужение и откатывали к `enableOnDemand: false`).
 *
 * Классификатор работает ДО первого LLM-вызова на сыром сообщении и только
 * ДОБАВЛЯЕТ теги (дефолты не снимает): простой чат остаётся узким (file/code +
 * alwaysOn), а research/browser/memory-задача сразу видит нужные тулы.
 * Без LLM-вызова и затрат контекста.
 *
 * Правила — keyword-эвристики (en+ru): `research` со сдвигом в recall
 * (пропуск веб-намерения стоит лишний enable_tools round-trip), `browser`/
 * `shell`/`memory`/`vision` — в precision (простые ходы остаются узкими).
 * Неизвестный текст — дефолты без изменений.
 */
/** Известные теги тулов. */
export const KNOWN_TOOL_TAGS = [
  "file",
  "code",
  "shell",
  "research",
  "browser",
  "vision",
  "image",
  "memory",
  "core",
] as const;

/** Тег из KNOWN_TOOL_TAGS. */
export type KnownToolTag = (typeof KNOWN_TOOL_TAGS)[number];

const RESEARCH_RE =
  /search|google|найди|найти|поиск|погод|новост|интернет|сайт|документ|стать|цен|стоим|курс|билет|рейтинг|обзор|рецепт|http|www\.|url|\bsite\b|\bweb\b|fetch|download|скача|загруз|stackoverflow|github\.com|wikipedia|википеди/i;

const BROWSER_RE =
  /screenshot|скриншот|playwright|browser|браузер|кликни|click\b|открой.*стран|automation|автоматизац.*браузер|селектор|selector/i;

const SHELL_RE =
  /process_|фонов|background|dev.?server|docker|deploy|депло|pipeline|пайплайн|контейнер|процесс/i;

const MEMORY_RE =
  /запомни|remember|recall|вспомни|память|\bmemory\b|мой день рождения|my birthday|мой рост|обо мне|preferences|предпочтени/i;

const VISION_RE =
  /image|картинк|фото|изображен|скрин|attach|vision|png|\bjpg\b|jpeg|сфотографируй|разбери.*фото/i;

const CODE_RE =
  /код|code|typescript|python|javascript|bun|npm|git|коммит|тест|lint|build|сборк|баг|ошибк.*код|файл|file|папк|директори|рефактор|refactor/i;

/**
 * Дополнительные теги из сообщения пользователя. Всегда подмножество
 * KNOWN_TOOL_TAGS, без `file`/`code` (это дефолты). Чистая функция —
 * безопасно вызывать на каждом ходе.
 */
export function inferExtraToolTags(input: string): KnownToolTag[] {
  if (!input || !input.trim()) return [];
  const extra = new Set<KnownToolTag>();
  if (RESEARCH_RE.test(input)) extra.add("research");
  if (BROWSER_RE.test(input)) {
    extra.add("browser");
    extra.add("vision");
  }
  if (SHELL_RE.test(input)) extra.add("shell");
  if (MEMORY_RE.test(input)) extra.add("memory");
  if (VISION_RE.test(input)) {
    extra.add("vision");
    extra.add("image");
  }
  // Явное code/shell-намерение возвращает `shell` (bash виден и через `code`,
  // но process_*/pipeline нужен именно shell-тег).
  if (CODE_RE.test(input) && /process|фонов|background|pipeline|docker/i.test(input)) {
    extra.add("shell");
  }
  return [...extra];
}

/**
 * Аддитивный preseed: дописывает выведенные теги в `activeTags`, возвращает
 * добавленные. Ничего не удаляет (гранты `enable_tools` сохраняются).
 * No-op при выключенном сужении (`activeTags` undefined = legacy-режим).
 */
export function seedToolTags(activeTags: string[] | undefined, input: string): string[] {
  if (!activeTags) return [];
  const added: string[] = [];
  for (const tag of inferExtraToolTags(input)) {
    if (!activeTags.includes(tag)) {
      activeTags.push(tag);
      added.push(tag);
    }
  }
  return added;
}
