/**
 * Состояние веб-визарда первого запуска: ответы, шаг, данные сервера.
 * Чистые данные и дефолты — единственный источник для остальных `setup-*.ts`.
 */

export type Dict = Record<string, any>;

export interface SetupSounds {
  enabled: boolean;
  done: boolean;
  question: boolean;
  failed: boolean;
  volume: number;
}

export interface SetupAnswers {
  provider: string;
  apiBase: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxToolIterations: number;
  locale: string;
  securityBashBlock: boolean;
  securityFlagsBlock: boolean;
  securityPathsRestrict: boolean;
  securityDetail: Dict;
  /** `false` — шаг 2.0 «Пропустить»: конфиг провайдера не трогаем. */
  configureProvider: boolean;
  /** Окно контекста определяется провайдером автоматически. */
  contextAuto: boolean;
  criticEnabled: boolean;
  webSearchEnabled: boolean;
  theme: string;
  themeMode: string;
  themeEffects: boolean;
  sounds: SetupSounds;
  [k: string]: any;
}

export interface SetupScan {
  done: boolean;
  servers: Array<{ label: string; url: string }>;
}

export interface ContextProbe {
  status: "idle" | "running" | "ok" | "fail";
  value?: number;
  /** baseUrl|model, для которых получен результат. */
  key?: string;
}

export interface SetupState {
  display: Dict | null;
  step: number;
  answers: SetupAnswers;
  scan: SetupScan;
  contextProbe: ContextProbe;
}

/** Экраны визарда в порядке прохождения. */
export const STEPS = [
  "welcome",
  "provider-choice",
  "provider",
  "key",
  "model",
  "context",
  "agent",
  "critic",
  "websearch",
  "appearance",
  "security",
  "review",
] as const;

export type SetupStep = (typeof STEPS)[number];

/** Полоса прогресса: четыре группы вместо двенадцати шагов. */
export const STEP_GROUPS = [
  { id: "intro", label: "web.setup.group.intro", steps: ["welcome"] },
  {
    id: "provider",
    label: "web.setup.group.provider",
    steps: ["provider-choice", "provider", "key", "model", "context"],
  },
  {
    id: "agent",
    label: "web.setup.group.agent",
    steps: ["agent", "critic", "websearch", "appearance", "security"],
  },
  { id: "review", label: "web.setup.group.review", steps: ["review"] },
] as const;

/** Индекс шага по id; неизвестный id — первый. */
export function stepIndex(id: string): number {
  const i = (STEPS as readonly string[]).indexOf(id);
  return i < 0 ? 0 : i;
}

/** Группа для текущего шага (id группы). */
export function groupOfStep(step: number): string {
  const name = STEPS[step] ?? STEPS[0];
  const group = STEP_GROUPS.find((g) => (g.steps as readonly string[]).includes(name));
  return group ? group.id : "intro";
}

/** Порядковый номер шага внутри его группы: «2 из 5». */
export function stepInGroup(step: number): { index: number; total: number } {
  const name = STEPS[step] ?? STEPS[0];
  const group = STEP_GROUPS.find((g) => (g.steps as readonly string[]).includes(name));
  if (!group) return { index: 1, total: 1 };
  return {
    index: (group.steps as readonly string[]).indexOf(name) + 1,
    total: group.steps.length,
  };
}

export function createSetupState(): SetupState {
  return {
    display: null,
    step: 0,
    scan: { done: false, servers: [] },
    contextProbe: { status: "idle" },
    answers: {
      provider: "",
      apiBase: "",
      apiKey: "",
      model: "",
      contextWindow: 32768,
      maxToolIterations: 200,
      locale: "en",
      securityBashBlock: false,
      securityFlagsBlock: false,
      securityPathsRestrict: true,
      securityDetail: { bash: {}, paths: {}, flags: {}, network: {}, advanced: {} },
      configureProvider: true,
      contextAuto: true,
      criticEnabled: true,
      webSearchEnabled: true,
      theme: "console",
      themeMode: "auto",
      themeEffects: true,
      sounds: { enabled: true, done: true, question: true, failed: true, volume: 50 },
    },
  };
}
