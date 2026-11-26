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
 * Правила — keyword-эвристики (en+ru): `web` для обычного веб-вопроса и
 * `research` только для явной работы с большим текстом/MCP/историей сессий.
 * Раньше любое веб-намерение добавляло `research` и открывало тяжёлые тулы
 * (`chunk_query`, `mcp_call`, `scan_corpus`) — сессия GYM24 получила 44 тула
 * в схеме (~7.5k токенов) и ушла в 196-секундный chunk_query.
 * `browser`/`shell`/`memory`/`vision` — в precision. Неизвестный текст — дефолты.
 */
/** Известные теги тулов. */
export const KNOWN_TOOL_TAGS = [
  "file",
  "code",
  "web",
  "document",
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

const WEB_RE =
  /search|google|найди|найти|поиск|погод|новост|интернет|сайт|документ|стать|цен|стоим|курс|билет|рейтинг|обзор|рецепт|http|www\.|url|\bsite\b|\bweb\b|fetch|download|скача|загруз|stackoverflow|github\.com|wikipedia|википеди/i;

/** Признак тяжёлой research-задачи: большие тексты, MCP, история сессий. */
const HEAVY_RESEARCH_RE =
  /chunk|чанк|corpus|корпус|scan_corpus|search_history|\bmcp\b|истори[яи]\s+(?:поиск|сесси)|больш(?:ой|ое)\s+текст|large text/i;

const BROWSER_RE =
  /screenshot|скриншот|playwright|browser|браузер|кликни|click\b|открой.*стран|automation|автоматизац.*браузер|селектор|selector/i;

const SHELL_RE =
  /process_|фонов|background|dev.?server|docker|deploy|депло|pipeline|пайплайн|контейнер|процесс/i;

const MEMORY_RE =
  /запомни|remember|recall|вспомни|память|\bmemory\b|мой день рождения|my birthday|мой рост|обо мне|preferences|предпочтени/i;

const VISION_RE =
  /image|картинк|фото|изображен|скрин|attach|vision|png|\bjpg\b|jpeg|сфотографируй|разбери.*фото/i;

const DOCUMENT_RE =
  /\.(xlsx|xls|ods|csv|tsv|docx|odt|pptx|pdf|md|markdown|ya?ml|json|xml|html?)\b|таблиц|документ|договор|отчёт|отчет|sheet|spreadsheet|през/i;

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
  if (WEB_RE.test(input)) extra.add("web");
  if (HEAVY_RESEARCH_RE.test(input)) extra.add("research");
  if (BROWSER_RE.test(input)) {
    extra.add("browser");
    extra.add("vision");
  }
  if (SHELL_RE.test(input)) extra.add("shell");
  if (MEMORY_RE.test(input)) extra.add("memory");
  if (DOCUMENT_RE.test(input)) extra.add("document");
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
 * No-op при выключенном сужении (`activeTags` undefined — legacy-режим)
 * и при пустом наборе (wide: все тулы уже в схеме — добавление тега только
 * СУЗИЛО бы набор, L4).
 */
export function seedToolTags(activeTags: string[] | undefined, input: string): string[] {
  if (!activeTags || activeTags.length === 0) return [];
  const added: string[] = [];
  for (const tag of inferExtraToolTags(input)) {
    if (!activeTags.includes(tag)) {
      activeTags.push(tag);
      added.push(tag);
    }
  }
  return added;
}
