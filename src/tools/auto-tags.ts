/**
 * Deterministic task-type → tool-tag inference for P5 auto-narrowing.
 *
 * The main loop exposes only `defaultTags` (+ `alwaysOn` structural tools) to
 * the LLM; everything else is hidden behind `enable_tools`. Without seeding,
 * a web task wastes its first turn discovering `enable_tools` — and the 9B
 * model sometimes drifts to shell/MCP instead (the reason narrowing was
 * rolled back to `enableOnDemand: false`).
 *
 * This classifier runs BEFORE the first LLM call on the raw user message and
 * only ADDS tags (never removes defaults), so a trivial chat stays narrow
 * (file/code + alwaysOn) while a research/browser/memory task arrives with
 * the right tools already visible. No LLM call, no context cost.
 *
 * Rules are keyword heuristics (en+ru), deliberately recall-biased for
 * `research` (a missed web intent costs a full enable_tools round-trip) and
 * precision-biased for `browser`/`shell`/`memory`/`vision` (keep trivial
 * turns narrow). Unknown text → defaults unchanged.
 */
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
 * Extra tags implied by the user message. Always a subset of KNOWN_TOOL_TAGS,
 * never includes `file`/`code` (those are the defaults). Pure function —
 * safe to call on every user turn.
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
  // Explicit code/shell intent re-adds `shell` (bash is already visible via
  // `code`, but process_*/pipeline need the shell tag).
  if (CODE_RE.test(input) && /process|фонов|background|pipeline|docker/i.test(input)) {
    extra.add("shell");
  }
  return [...extra];
}

/**
 * Additive pre-seed: push inferred tags missing from `activeTags` into it.
 * Returns the tags that were added. Never removes anything, so mid-session
 * `enable_tools` grants are preserved. No-op when narrowing is disabled
 * (`activeTags` undefined means legacy all-tools mode).
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
