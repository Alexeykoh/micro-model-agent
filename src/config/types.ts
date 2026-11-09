// Типы конфига AppConfig: провайдеры, бюджет, критик, безопасность, UI.
import type { ContextBudget } from "./types-budget";
import type { ServiceConfig } from "./types-service";
import type { ExpertConfig } from "./types-experts";
import type { MemoryValidatorConfig } from "./memory-types";
import type { LspConfig } from "../modules/lsp/types";
import type { ModelCapabilities, PricingConfig, ProviderConfig, RetryConfig } from "./types-provider";
import type { ReasoningConfig } from "./types-reasoning";
import type { SecurityConfig, SessionIsolationConfig } from "./types-security";
import type {
  BrowserToolConfig,
  ContextLogConfig,
  CriticConfig,
  ErrorWebSearchConfig,
  HallucinationConfig,
  ImagesConfig,
  IndexerConfig,
  InstructionsConfig,
  MCPServerConfigEntry,
  ModelLoadConfig,
  PluginsConfig,
  SessionConfig,
  SkillsConfig,
  SubagentConfig,
  ToolsConfig,
  UiConfig,
  UpdaterConfig,
  WebSearchConfig,
} from "./types-runtime";

export type {
  CacheCapability,
  CacheMechanism,
  CacheReportFormat,
  ModelCapabilities,
  ModelPrice,
  PricingConfig,
  ProviderConfig,
  ProviderEntry,
  RateLimitConfig,
  RetryConfig,
} from "./types-provider";
export type {
  ReasoningConfig,
  ReasoningLevel,
  ReasoningMode,
  ReasoningStrategy,
} from "./types-reasoning";
export type {
  AuditEventType,
  AuditNotifierConfig,
  BashSecurityConfig,
  ContentScanConfig,
  NetworkSecurityConfig,
  PathSecurityConfig,
  SecurityConfig,
  SessionEncryptionConfig,
  SessionIsolationConfig,
} from "./types-security";
export type {
  BrowserToolConfig,
  ContextLogConfig,
  CriticConfig,
  ErrorWebSearchConfig,
  HallucinationConfig,
  ImagesConfig,
  IndexerConfig,
  InstructionsConfig,
  MCPHeader,
  MCPServerConfigEntry,
  ModelLoadConfig,
  PluginsConfig,
  SessionConfig,
  SkillsConfig,
  SubagentConfig,
  ToolsConfig,
  UiConfig,
  UpdaterConfig,
  WebSearchConfig,
} from "./types-runtime";

export type { ContextBudget };

export type { ExpertConfig };

export type { ServiceConfig } from "./types-service";

export type { MemoryValidatorConfig } from "./memory-types";

export interface AppConfig {
  version: string;
  model: string;
  provider: ProviderConfig;
  experts: Record<string, ExpertConfig>;
  /**
   * Переопределения возможностей по моделям (ключ — id модели). Самый приоритетный
   * источник в `resolveModelCapabilities`: бьёт живой пробник и пресет провайдера.
   * Позволяет пригвоздить vision/tools модели, где пресет/пробник ошибаются.
   */
  modelCapabilities?: Record<string, ModelCapabilities>;
  tools: ToolsConfig;
  contextWindow: number;
  /**
   * Авто-детект окна контекста у провайдера для активной модели (default true):
   * проба на старте и при смене модели/провайдера применяется поверх значения.
   * Запись конкретного `contextWindow` (веб-селектор, `/context`, `mma context`)
   * выключает флаг — ручной выбор побеждает пробу. Опциональное поле: старые
   * конфиги без него читаются как auto.
   */
  contextAuto?: boolean;
  contextBudget: ContextBudget;
  /** Детерминированный гейт качества записей памяти (TODO §1.6, Phase A). */
  memory?: { validator?: Partial<MemoryValidatorConfig>; retentionDays?: number };
  instructions: InstructionsConfig;
  modelLoad: ModelLoadConfig;
  retry: RetryConfig;
  maxToolIterations: number;
  stuckThreshold: number;
  autoPlan: boolean;
  /** Настройки execution-модуля: autoAdvance — автопометка done по файлам (дефолт true).
   * + профиль исполнения (P0 изоляция): profile — local-trusted = хост, sandbox = Docker. */
  execution?: {
    autoAdvance?: boolean;
    profile?: "local-trusted" | "sandbox";
    image?: string;
  };
  showReasoning: boolean;
  logLevel: string;
  locale: string;
  session: SessionConfig;
  contextLog: ContextLogConfig;
  indexer: IndexerConfig;
  images?: ImagesConfig;
  browser: BrowserToolConfig;
  webSearch?: WebSearchConfig;
  errorWebSearch?: ErrorWebSearchConfig;
  pricing?: PricingConfig;
  ui: UiConfig;
  mcpServers: Record<string, MCPServerConfigEntry>;
  security?: SecurityConfig;
  sessionIsolation?: SessionIsolationConfig;
  skills: SkillsConfig;
  /** Реестр плагинов: deny-list выключенных. Опциональное гнездо (ленивая инициализация). */
  plugins?: PluginsConfig;
  subagent: SubagentConfig;
  hallucination?: HallucinationConfig;
  lsp?: LspConfig;
  updater: UpdaterConfig;
  reasoning?: ReasoningConfig;
  critic: CriticConfig;
  service: ServiceConfig;
}
