/**
 * Типы системы режимов агента.
 *
 * Mode = вариант настройки агента. Определяет:
 * - Какой system prompt использовать
 * - Какие инструменты/скилы доступны
 * - Какие поведения включены
 * - Как выглядит UI
 *
 * @module agent/modes/types
 */

/** Конфигурация режима агента */
export interface ModeConfig {
  /** Уникальный id режима */
  id: string;
  /** Отображаемое имя */
  label: string;
  /** Ключ шаблона system prompt ('fast' | 'base' | 'pro') */
  systemPromptTemplate: string;

  /** Ограничения */
  constraints: {
    /** Макс. количество скилов (0 = безлимит) */
    maxSkills: number;
    /** Бюджет токенов для скилов */
    skillTokenBudget: number;
    /** Минимальный контекст (0 = не ограничен, pro = 64000) */
    minContextWindow: number;
  };

  /** Принудительная загрузка скилов (например grill-me для pro) */
  forcedSkills: string[];
  /** Разрешить автозагрузку скилов по @упоминаниям */
  allowAutoLoadSkills: boolean;

  /** Поведения ( Record для расширяемости) */
  behaviors: Record<string, unknown>;

  /** Плагины, активируемые в этом режиме */
  plugins?: string[];

  /** UI настройки */
  ui: {
    showThinking: boolean;
    quiet: boolean;
    /** Префикс в промпте ('[fast]' / '[pro]' / '') */
    promptPrefix: string;
  };

  /** Какой режим наследует subagent (id) */
  subagentMode: string;
}

/** Контекст для applyMode */
export interface ModeContext {
  quiet?: boolean;
  showThinking?: boolean;
  renderer?: {
    setMode?: (mode: string) => void;
    updateStatus?: (info: Record<string, unknown>) => void;
  };
}
