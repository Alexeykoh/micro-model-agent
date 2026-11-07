/**
 * Состояние веб-визарда первого запуска: ответы, шаг, данные сервера.
 * Чистые данные и дефолты — единственный источник для остальных `setup-*.ts`.
 */

export type Dict = Record<string, any>;

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
  [k: string]: any;
}

export interface SetupState {
  display: Dict | null;
  step: number;
  answers: SetupAnswers;
}

export const STEPS = ["language", "provider", "key", "model", "context", "security", "review"];

export function createSetupState(): SetupState {
  return {
    display: null,
    step: 0,
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
      soundsEnabled: true,
      securityDetail: { bash: {}, paths: {}, flags: {}, network: {}, advanced: {} },
    },
  };
}
