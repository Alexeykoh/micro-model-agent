// Face states and their single mapping table (extracted from `loader.ts`,
// rule ≤300). One place maps tools/lifecycle signals → face state, so the feed
// and the rail can never diverge.

export type FaceState =
  | "idle"
  | "think"
  | "read"
  | "find"
  | "web"
  | "edit"
  | "type"
  | "create"
  | "run"
  | "tests"
  | "compact"
  | "plan"
  | "ask"
  | "done"
  | "error"
  | "stop"
  | "queued"
  | "boot"
  | "load"
  | "update"
  | "check"
  | "warn"
  | "recheck"
  | "verify";

export type FaceSize = "sm" | "lg" | "xs";

// state → modifier classes (color + animation + mood). Kept in one place so
// the feed and the rail can never diverge.
export const FACE_CLASS: Record<FaceState, string> = {
  idle: "c-dim track poke blink",
  think: "c-active st-think blink",
  read: "c-recon st-read",
  find: "c-recon st-find squint",
  web: "c-recon st-web squint",
  edit: "c-mutate st-edit narrow",
  type: "c-active st-type narrow",
  create: "c-mutate st-create",
  run: "c-exec st-run",
  tests: "c-exec st-tests",
  compact: "c-active st-compact",
  plan: "c-active st-plan",
  ask: "c-warn st-ask wide",
  done: "c-ok st-done happy celebrate",
  error: "c-err st-error sad",
  stop: "c-dim st-stop sleep",
  queued: "c-dim st-queued blink",
  boot: "c-dim st-boot",
  load: "c-dim st-load",
  // An available update is good news: sparkly and awake. No `track`/`poke` —
  // the mascot should not follow the cursor while advertising something, and
  // a click on it should not pop the greeting over the update chip.
  update: "c-ok st-update happy",
  // LSP: осмотр кода (измеряющий пульс, взгляд вбок — «смотрю, что скажет
  // компилятор»). Проверка ничего не пишет, поэтому recon-цвет.
  check: "c-recon st-check squint",
  // LSP: компилятор нашёл ошибки. Тревога слабее, чем `error`: это рабочая
  // обратная связь от сервера, а не сбой харнесса.
  warn: "c-warn st-warn squint",
  // Гейт забраковал уже показанный черновик → модель перечитывает и
  // переписывает. Это штатная перепроверка, а не сбой: recon-цвет, взгляд вбок.
  recheck: "c-recon st-recheck squint",
  verify: "c-recon st-verify squint",
};

// Tool name → loader state (matches STYLE.md tool categories). Every core
// tool has a state, so the face never falls back to a generic "run" for a
// known behavioural category (ask, research, memory, introspection).
const TOOL_STATE: Record<string, FaceState> = {
  read_file: "read",
  list_dir: "read",
  file_info: "read",
  load_skill: "read",
  session_info: "read",
  grep: "find",
  glob: "find",
  project_map: "find",
  chunk_query: "find",
  history: "find",
  recall: "find",
  search_history: "find",
  web_search: "web",
  web_fetch: "web",
  download_file: "web",
  web_browse: "web",
  write_file: "create",
  create_dir: "create",
  define_capability: "create",
  remember: "create",
  edit_file: "edit",
  move_file: "edit",
  delete_file: "edit",
  attach_image: "edit",
  bash: "run",
  pipeline_run: "run",
  process_wait: "run",
  process_kill: "run",
  browser: "run",
  subagent: "run",
  mcp_call: "run",
  enable_tools: "run",
  plan: "plan",
  todo: "plan",
  verify: "plan",
  lsp_check: "check",
  set_thinking: "think",
  approve: "ask",
  question: "ask",
  meet_done: "done",
};

export interface LoaderSignal {
  type:
    | "phase"
    | "tool_start"
    | "tool_end"
    | "text"
    | "question"
    | "turn_end"
    | "error"
    | "retract"
    | "index"
    | "setup_done"
    | "update"
    | "verify"
    | "usage"
    | "state"
    | "config"
    | "files"
    | "sessions"
    | "plugins"
    | "log";
  name?: string;
  phase?: string;
  success?: boolean;
  /** Вывод тула — нужен, чтобы отличить LSP-ошибки от успешного тула. */
  output?: string;
}

/**
 * Что LSP дописал в вывод тула. Пост- проверка после `write_file`/`edit_file`
 * и `lsp_check` помечают результат маркерами `[LSP ...]`; по ним маскот
 * понимает, радоваться или тревожиться.
 *
 * - `errors` — сервер вернул error'ы (рабочая обратная связь);
 * - `failed` — сервер недоступен или отключён (проблема харнесса, не кода).
 */
export function lspOutputSignal(output: string | undefined): "errors" | "failed" | null {
  if (!output) return null;
  if (output.includes("[LSP check failed") || output.includes("[LSP disabled")) return "failed";
  if (output.includes("[LSP errors]")) return "errors";
  return null;
}

export function toolState(name: string): FaceState {
  return TOOL_STATE[name] || "run";
}

// Pure mapping used by both the feed and the rail.
export function loaderStateFor(s: LoaderSignal): FaceState {
  switch (s.type) {
    case "turn_end":
      return s.success === false ? "error" : "done";
    case "error":
      return "error";
    // A retracted draft is a rejected claim, not a broken harness: the face
    // shows a calm "re-read and rewrite" mood, never the error face.
    case "retract":
      return "recheck";
    // Гейт (критик/аудит) проверяет уже показанный ответ: своё спокойное
    // состояние, а не `think` (модель не думает) и не `error` (это штатно).
    case "verify":
      return "verify";
    case "question":
      return "ask";
    case "text":
      return "type";
    case "tool_start":
    case "tool_end": {
      const name = s.name || "";
      // `lsp_check` отвечает success:false именно тогда, когда нашёл ошибки —
      // это обратная связь, а не сбой.
      if (name === "lsp_check" && s.type === "tool_end" && s.success === false) return "warn";
      // Пост- проверка LSP после write/edit живёт в выводе тула.
      const lsp = lspOutputSignal(s.output);
      if (s.type === "tool_end") {
        if (lsp === "errors") return "warn";
        if (lsp === "failed") return "error";
      }
      return toolState(name);
    }
    // Re-indexing is a workspace-wide search.
    case "index":
      return "find";
    case "setup_done":
      return "done";
    // Unlike the broadcasts below, an update is news for the user — the mascot
    // celebrates it. The persistent part lives in the footer chip (snapshot).
    case "update":
      return "update";
    // Background broadcasts (usage/state/config/files/sessions/plugins/log)
    // carry no agent activity: the face must NOT move on them, they map to
    // idle and callers are expected to drop the event instead of animating.
    case "usage":
    case "state":
    case "config":
    case "files":
    case "sessions":
    case "plugins":
    case "log":
      return "idle";
    default:
      return "think";
  }
}
