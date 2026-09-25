import { loadConfig } from "../config/config";
import { Logger } from "../logger/app-logger";
import type { LogLevel } from "../logger/app-logger";
import { buildActiveProvider } from "../modules/providers/factory";
import { BUILTIN_PROVIDERS } from "../modules/providers/presets";
import type { LLMProvider } from "../llm/provider";
import { ModelLoader } from "../llm/model-loader";
import { ToolRegistry, registerAllTools } from "../tools/index";
import { buildHiddenToolsBlock } from "../tools/hidden-tools-block";
import { ToolExecutor } from "../tools/executor";
import { ModuleRegistry } from "../modules/registry";
import { PluginManager } from "../modules/plugins/manager";
import { PluginLoader } from "../modules/plugins/loader";
import { plugin as lintOnWritePlugin } from "../modules/plugins/builtin/lint-on-write";
import { plugin as notifyPlugin } from "../modules/plugins/builtin/notify";
import { ContextManager } from "../modules/context/manager";
import { TokenCounter, estimateTokens } from "../llm/token-counter";
import { HallucinationDetector } from "../modules/hallucination/detector";
import { ExecutionModule } from "../modules/execution/module";
import { SessionStore, SessionManager, SessionModule } from "../modules/session/index";
import { UserProfile } from "../modules/user-profile/profile";
import { SkillsLoader, SkillsModule } from "../modules/skills/index";
import { BrowserModule } from "../modules/browser/index";
import { LspModule, FileOnlyLogger, DEFAULT_LSP_CONFIG } from "../modules/lsp/index";
import { runStartupHealthCheck } from "../modules/lsp/startup-check";
import { IndexerModule } from "../modules/indexer/index";
import { MCPModule } from "../modules/mcp/index";
import { MemoryModule } from "../modules/memory/module";
import { MemoryStore } from "../modules/memory/store";
import { t, setLocale, setMissingKeyReporter } from "../i18n/index";
import { Agent } from "./agent";
import { ContextLogger } from "./agent/context-log";
import { homedir } from "os";
import { join, resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { AgentDeps } from "./agent";
import type { ToolContext } from "../tools/types";
import type { PromptBlock } from "./types";
import type { AppConfig, ModelCapabilities } from "../config/types";
import { resolveModelCapabilities } from "../modules/providers/capabilities";
import { readMmaVersion } from "./version";
import { collectEnvironment, logEnvironment } from "./environment";
import { errMsg } from "../utils";
import { dryRunOverflow, overflowHint } from "./prompt-overflow";
import { probeModel, type ContextProbeResult } from "../llm/model-loader";
import type { AgentPlugin } from "../modules/types";
import type { ReasoningLevel } from "../config/types";

/**
 * CLI --reasoning переопределяет конфигурационный режим
 * (приоритет: CLI > config > default). "auto" пропускается — полагаемся
 * на конфиг. Строка CLI приводится к типизированному ReasoningLevel.
 */
export function applyReasoningCliOverride(
  config: AppConfig,
  reasoningLevel: string | undefined,
): void {
  if (!reasoningLevel || reasoningLevel === "auto") return;
  if (!config.reasoning) {
    config.reasoning = {
      mode: reasoningLevel as ReasoningLevel,
      min: "low",
      max: "high",
      overrideCooldown: 3,
    };
  } else {
    config.reasoning.mode = reasoningLevel as ReasoningLevel;
  }
}

/** Регистрация встроенного плагина модуля: пометка + регистрация. */
function registerBuiltinPlugin(pm: PluginManager, plugin: AgentPlugin | undefined): void {
  if (!plugin) return;
  plugin.isBuiltin = true;
  pm.register(plugin);
}

/**
 * Загрузка AGENTS.md из базового каталога проекта и конфиг-каталога
 * (в порядке приоритета). Каждый найденный непустой файл — prompt-блок
 * высокого приоритета.
 */
/** Candidate AGENTS.md paths, in priority order: project, project `.mma`, global config. */
export function agentsMdPaths(baseDir: string, configDir: string): string[] {
  return [join(baseDir, "AGENTS.md"), join(baseDir, ".mma", "AGENTS.md"), join(configDir, "AGENTS.md")];
}

function loadAgentsMdBlocks(baseDir: string, dir: string, skip: boolean): PromptBlock[] {
  if (skip) return [];
  const blocks: PromptBlock[] = [];
  const candidates = agentsMdPaths(baseDir, dir);
  for (const p of candidates) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8").trim();
      if (content) {
        blocks.push({
          content,
          priority: "high",
          essential: false,
          estimatedTokens: estimateTokens(content),
          kind: "instructions",
        });
      }
    }
  }
  return blocks;
}

/** Reject `promise` after `ms`; the winner's timer is cleared. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const VALID_LOG_LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

/** Нормализует строку из конфига в LogLevel (без `as any`); неизвестное → info. */
function normalizeLogLevel(value: string | undefined): LogLevel {
  return value && VALID_LOG_LEVELS.includes(value) ? (value as LogLevel) : "info";
}

export function buildSystemInfo(
  config: AppConfig,
  baseDir: string,
  profileCompressed: string,
): string {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const isWin = profileCompressed.toLowerCase().includes("win32");
  const lines: string[] = [
    `You are MMA v2, an AI coding agent for small models (${config.model}). Date: ${now}. Workspace: ${baseDir}. ${profileCompressed}.`,
    `Reply in the user's language. Use tools for file ops (read/write/edit/delete), search (glob/grep), shell (bash), web, subagents, browser, MCP. Explain briefly if not obvious. On tool failure: analyze, fix the call, retry up to 2x with different approaches, then ask the user.`,
    `Design: YAGNI (no unneeded code), KISS (simple over clever), DRY (reuse existing utilities).`,
    `ARTIFACTS: when the user asks for a document or file (specification, design, README, plan file, config, script, report), CREATE it as a real file in the workspace — a plan described only in chat or held in your reasoning is NOT the artifact. Use the format and stack the user requested, and do not add libraries/tools that were not agreed or listed; if the request is silent on a needed choice, ask or search before adding dependencies.`,
    `SCOPE DISCIPLINE: do ONLY what the user explicitly asked — no extra features, files, refactors, "improvements", or fixes beyond the request. Read-only requests ("расскажи", "покажи", "объясни", "check") mean READ-ONLY: inspect and answer, never create/modify/delete anything. If the task is ambiguous (what to create, where, which variant) or the request implies action on something you could not find — STOP and ask the user a short clarifying question in plain text instead of guessing.`,
    `INPUT PRIORITY: the current user message outranks stored memory/preferences/facts. Never override, reinterpret, or "correct" an explicit value the user states now (city, path, name, language, choice) because a stored preference disagrees — follow the user's current message. If they truly conflict or look like a typo, ask the user instead of assuming.`,
    `PROTECTED PATHS: never write/edit/delete/move VCS internals (.git/, .hg/, .svn/) or secret/env files (.env*, *.key, *.pem, *.p12, *.pfx, *.crt, *.secret, *.token, .npmrc, .netrc, .git-credentials, .gitconfig) without explicit user confirmation. If a file tool reports a protected path, STOP and ask the user in plain text whether to proceed, then wait — do not retry around it or work around it with bash.`,
    `NOT FOUND ≠ MISSING PROJECT: a "not found" tool result means the PATH was wrong (typo, different location), not that the project does not exist. Before creating or scaffolding ANY project/files: first run list_dir on the working directory to see what is already there; if a user-named path is not found, list its parent directory to locate the real path. NEVER create a new project when the user asked about an existing one — inspect first, create only after confirming the workspace is empty AND the user asked for creation.`,
  ];

  if (isWin) {
    lines.push(
      `Windows (PowerShell): use list_dir/read_file/delete_file/create_dir tools instead of dir/type/del/mkdir. No PowerShell cmdlets (Get-Content, Select-Object, Write-Output), no head/tail/grep/cat. Use forward slashes in paths. CWD: ${baseDir}`,
    );
  }

  // MMA is a Bun-only project (package.json scripts, Bun API in code) — the
  // model should prefer bun over node/tsx/ts-node for running TypeScript
  // files and tests (observed: model wasted 10+ iterations installing tsx
  // instead of running `bun file.ts`).
  lines.push(
    `Runtime: Bun is available — run TypeScript directly with "bun <file.ts>" and tests with "bun test" (no tsx/ts-node/npm install needed for that).`,
  );

  lines.push(
    `Bash: use "workdir" param instead of "cd dir && cmd". One command per call. Long-running processes: pass "background: true" (id immediately), otherwise auto-backgrounded after a few seconds — check with process_log.`,
    `DEVELOPMENT RULES (strict): 1) install deps BEFORE writing source (npm/pip/cargo, verify lockfile exists; never import uninstalled packages); 2) framework/toolkit init BEFORE app code; 3) follow plan sequentially, after each step verify deliverables exist with real content, then "plan update step=N status=done"; 4) verify work on disk + command output — don't assume success; 5) no premature work (no files/imports for future steps); 6) stuck after 2+ failures: STOP, try a different approach, write files directly, ask the user.`,
    `VERIFY EVERY WRITE: after write_file or edit_file, if the tool result contains NO [LSP errors], [LSP warnings], [Syntax check failed], or [Project typecheck failed] feedback, call the "lsp_check" tool on the file you just wrote BEFORE marking the step done. Never assume a written file is valid — prove it.`,
    `PLAN QUALITY: each step = CONCRETE deliverables (exact file paths with extensions, exact packages, exact commands). Vague steps ("Setup the project") forbidden. Cover init → deps → framework → code → verification. 5-8 steps.`,
    `For "check/fix errors" tasks, each verification step must name the exact command that proves the errors are gone — "bun run build", "bun test", or the "lsp_check" tool — and the step is done only after that check reports clean.`,
  );

  if (config.autoPlan) {
    lines.push(
      `Plan rule (MANDATORY): any task creating files, installing packages, or requiring multiple actions MUST create a plan with the "plan" tool BEFORE starting. Each step = a concrete deliverable.`,
    );
  }

  // When a bug is described in terms of runtime behavior (what happens when
  // the app runs), the fix is only provable by REPRODUCING it — running the
  // app/build/browser and comparing against actual output. The model decides
  // when this applies (no keyword classification). Stale dev servers started
  // before a config/deps change keep the OLD pipeline in memory and still
  // throw the original error (observed: old vite on 5173-5176 kept failing
  // postcss after the fix was on disk, while a fresh server on 5177 was
  // clean) — the fix is only real when the USER's running server is clean.
  lines.push(
    `Runtime verification: when a bug is described in terms of runtime behavior (what happens when the app runs), reproduce it — run the app / build / browser tool — and confirm the fix against actual runtime output before calling "plan update step=N status=done". Check existing servers first with process_list/process_log: a stale dev server started BEFORE your change still runs the old pipeline and keeps failing even after the files on disk are fixed. Restart or kill it (process_kill) and verify the exact endpoint/port the user reported — a fresh server on a new port does NOT prove the user's error is gone.`,
  );

  // Explicit completion criteria: a 9B model tends to keep "improving" or to
  // declare success without proof. One short section each, naming observable
  // conditions, so the model can find them and knows when to stop or ask.
  lines.push(
    `DONE CONDITIONS — you are finished only when ALL hold: all plan steps are marked done; the requested files/artifacts exist with real content (not merely described in chat); each verification command you can run reports clean. Then reply with a short summary of what changed (files created/edited).`,
    `STOP AND ASK THE USER WHEN: the task is ambiguous (multiple valid approaches, or unclear what/where); you could not find what the user asked about after listing the parent directory; finishing would delete or overwrite important files; or you are stuck after 2+ different approaches. Write one short clarifying question in plain text and wait — do not guess.`,
  );

  // Security rules: when security is enabled the model should know the
  // restrictions up front — a blocked call costs an iteration, while this
  // block costs ~100 tokens once. Kept compact and capped so a long user
  // blacklist cannot blow the system budget.
  const sec = config.security;
  if (sec?.enabled) {
    const secLines: string[] = [
      `SECURITY RESTRICTIONS (enforced — blocked calls return "[SECURITY BLOCKED]", do not retry them):`,
    ];
    if (sec.bash?.enabled && sec.bash.blacklist.length > 0) {
      const cmds = sec.bash.blacklist.slice(0, 15).join(", ");
      secLines.push(
        `Forbidden bash commands: ${cmds}${sec.bash.blacklist.length > 15 ? ", …" : ""}.`,
      );
      if (sec.bash.whitelist.length > 0) {
        secLines.push(
          `Only whitelisted bash commands are allowed: ${sec.bash.whitelist.slice(0, 15).join(", ")}.`,
        );
      }
      if (sec.bash.blockDangerousFlags) {
        secLines.push(
          `Pipes/redirects/chaining (| > >> ; &&) in bash are blocked — one plain command per call.`,
        );
      }
    }
    if (sec.paths?.enabled && sec.paths.denied.length > 0) {
      const paths = sec.paths.denied.slice(0, 10).join(", ");
      secLines.push(
        `Denied paths (read/write): ${paths}${sec.paths.denied.length > 10 ? ", …" : ""}.`,
      );
    }
    if (sec.network?.enabled && sec.network.deniedDomains.length > 0) {
      const domains = sec.network.deniedDomains.slice(0, 10).join(", ");
      secLines.push(
        `Denied network domains: ${domains}${sec.network.deniedDomains.length > 10 ? ", …" : ""}.`,
      );
    }
    if (secLines.length > 1) {
      lines.push(...secLines);
    }
  }

  const hasMCP =
    config.mcpServers && Object.values(config.mcpServers).some((s) => s.enabled !== false);
  if (hasMCP) {
    lines.push(
      `MCP servers are available — use the named MCP tools (prefixed mcp__) to query external services.`,
    );
  }

  return lines.join("\n");
}

export interface BootstrapResult {
  agent: Agent;
  config: AppConfig;
  logger: Logger;
  sessionManager: SessionManager;
  skillsModule: SkillsModule;
  pluginManager: PluginManager;
  /** Owner of plan state — UI consumers (REPL) read the active plan from
   *  here instead of re-reading .mma/plans/active.json from disk. */
  execModule: ExecutionModule;
  /** Shared ToolContext; `sessionId`/`sessionContext` are live getters over
   *  the session manager, so a session switch is always reflected. */
  toolCtx: ToolContext;
  /** Live tool registry. Web mode registers interactive tools (question/approve)
   *  into it after bootstrap without touching terminal behavior. */
  toolRegistry: ToolRegistry;
  configDir: string;
  baseDir: string;
  noAgentsMd: boolean;
  envReport: ReturnType<typeof collectEnvironment>;
  /** true when legacy config.json was used (no domain files found). */
  legacyDetected: boolean;
  /** Background probe of the context length the model is ACTUALLY loaded
   *  with (LM Studio native API). Resolves to null when not applicable. */
  contextProbe: Promise<ContextProbeResult | null>;
  /** Shared global memory store — the same instance the memory module and the
   *  agent loop use, so UI consumers (`mma web` `/memory`) read/write live data. */
  memoryStore: MemoryStore;
  /** Project-map indexer — web mode surfaces its stats in the environment panel. */
  indexerModule: IndexerModule;
}

/**
 * One-shot CLI subcommands (`session show`, `usage`, `config` …) paint a result
 * and exit. The background startup health check spawns a child (LSP server /
 * tsc) that `process.exit` does not reap — on Windows the orphan keeps the
 * stdout pipe open, so piping the command (`mma session show <id> | cat`)
 * hangs. Subcommands never run an agent, so the check is skipped there.
 */
let oneShotMode = false;
export function setOneShotMode(value: boolean): void {
  oneShotMode = value;
}

export async function bootstrap(
  configDir?: string,
  projectDir?: string,
  noAgentsMd?: boolean,
  exitOnComplete?: boolean,
  reasoningLevel?: string,
  contextLog?: boolean,
): Promise<BootstrapResult> {
  const dir = configDir || process.env.MMA_CONFIG_DIR || join(homedir(), ".mma");
  const projectConfigPath = projectDir ? join(projectDir, ".mmrc") : join(process.cwd(), ".mmrc");

  const { config, legacyDetected } = loadConfig({ configDir: dir, projectConfigPath });
  setLocale(config.locale);

  // CLI --reasoning overrides config mode (priority: CLI > config > default)
  applyReasoningCliOverride(config, reasoningLevel);

  // Update global audit notifier with config
  let auditNotifyError: string | undefined;
  try {
    const { globalAuditNotifier } = await import("../modules/security/audit-notifier");
    if (config.security?.auditNotifier) {
      globalAuditNotifier.updateConfig(
        config.security.auditNotifier as Partial<typeof config.security.auditNotifier>,
      );
    }
  } catch (err) {
    // Logger ещё не создан — запомним и залогируем после его инициализации.
    auditNotifyError = errMsg(err);
  }

  const logger = new Logger(normalizeLogLevel(config.logLevel));
  logger.setLogDir(join(dir, "logs"));
  // Диагностика опечаток в ключах i18n — видна только на debug-уровне.
  setMissingKeyReporter((key) => logger.debug(`Missing i18n key: ${key}`));
  if (auditNotifyError) {
    logger.debug(`Audit notifier config skipped: ${auditNotifyError}`);
  }
  logger.debug("MMA bootstrap", {
    version: config.version,
    model: config.model,
  });

  // Sync the manifest bundled with this package version into
  // ~/.mma/certifications.json (bundled entries overwrite their keys on
  // update; user-local certifications are preserved). Best-effort, silent.
  try {
    const { syncGlobalManifest } = await import("../modules/certification/manifest");
    const syncResult = syncGlobalManifest();
    if (syncResult.synced) {
      logger.debug("Certification manifest synced from package");
    }
  } catch {
    // Certification marks are cosmetic — never block startup.
  }

  if (config.modelLoad.autoLoad) {
    const modelLoader = new ModelLoader(config.provider.baseUrl, logger);
    const loadResult = await modelLoader.ensureModelLoaded({
      model: config.model,
      contextLength: config.contextWindow,
      flashAttention: config.modelLoad.flashAttention,
      offloadKvCacheToGpu: config.modelLoad.offloadKvCacheToGpu,
      autoLoad: config.modelLoad.autoLoad,
    });

    if (!loadResult.success) {
      logger.warn(t("env.model_autoload_failed", { error: String(loadResult.error ?? "") }));
    } else if (loadResult.alreadyLoaded) {
      logger.debug(`Model ${config.model} already loaded`);
    } else {
      logger.info(
        t("env.model_loaded", { model: config.model, seconds: String(loadResult.loadTime) }),
      );
    }
  }

  // Context probe (background): ask the provider (LM Studio native API) for
  // the context length the model is ACTUALLY loaded with and compare it with
  // the configured contextWindow. Never blocks the banner; null = probe not
  // applicable (not LM Studio / model not loaded / transient error).
  // Живой источник возможностей модели для тулов (browser vision и т.п.).
  // Пресет и конфиг-оверрайд известны сразу, native-probe уточняет их
  // асинхронно и записывает сюда, не блокируя старт. Геттер на toolCtx
  // резолвит итог при каждом обращении, поэтому смена модели/провайдера
  // через reconfigure видна тулам без пересборки контекста.
  const capabilitiesRef: { probe?: ModelCapabilities } = {};

  const contextProbePromise: Promise<ContextProbeResult | null> = (async () => {
    try {
      const probe = await probeModel(config.provider.baseUrl, config.model);
      if (!probe) return null;
      if (probe.capabilities) capabilitiesRef.probe = probe.capabilities;
      const contextProbe: ContextProbeResult = { model: probe.model, actual: probe.contextLength };
      if (probe.contextLength < config.contextWindow) {
        logger.logSilent(
          "warn",
          `Context probe: model "${probe.model}" is loaded with ${probe.contextLength} tokens, but contextWindow is configured as ${config.contextWindow} — overflow/429 risk. Lower contextWindow or reload the model with a larger context.`,
        );
      } else if (probe.contextLength > config.contextWindow) {
        logger.logSilent(
          "info",
          `Context probe: model "${probe.model}" supports ${probe.contextLength} tokens — consider "mma context ${probe.contextLength}" to use the full window.`,
        );
      } else {
        logger.logSilent(
          "debug",
          `Context probe: configured contextWindow matches loaded context (${probe.contextLength})`,
        );
      }
      return contextProbe;
    } catch {
      return null;
    }
  })();

  const profile = new UserProfile(join(dir));
  profile.load() || profile.collect();
  profile.save();

  // Multi-provider manager (Phase 2) + optional transparent failover wrapper
  // (Phase 4.2). Built through the shared factory so a hot-swap via
  // Agent.setProvider gets the SAME fallback behavior as startup instead of
  // rebuilding a bare manager that silently drops failover (B4).
  //
  // Session id is resolved lazily: the session manager is created further down,
  // and providers must read the CURRENT session at request time (hot-swap,
  // session switch). OpenCode Go rejects requests without `x-opencode-session`.
  let activeSessionManager: SessionManager | undefined;
  const getSessionId = (): string | undefined => activeSessionManager?.getActiveMeta()?.id;
  const builtProvider = buildActiveProvider(config, logger, { getSessionId });
  const providerManager = builtProvider.manager;
  const llmProvider = builtProvider.provider;

  // Resolve reasoning strategy from provider preset + probe
  const providerSpec = BUILTIN_PROVIDERS.find((p) => p.type === config.provider.type);
  const reasoningStrategy = providerSpec?.capabilities.reasoningStrategy ?? "none";

  // Reasoning probe runs in the BACKGROUND (B2). It used to block bootstrap
  // with an extra LLM round-trip on every launch; the agent now consumes it
  // lazily before the first LLM call (same pattern as the startup health
  // check) and treats the mechanism as NOT passed until it resolves. The 24h
  // TTL disk cache in probe.ts already avoids re-probing a stable backend.
  let reasoningProbePromise: Promise<boolean> = Promise.resolve(false);
  if (config.reasoning && config.reasoning.mode !== "none" && reasoningStrategy !== "none") {
    reasoningProbePromise = (async () => {
      try {
        const { probeReasoningSupport, getCachedProbeResult, setCachedProbeResult } =
          await import("../modules/reasoning/probe");
        const cacheK = `${config.provider.baseUrl ?? ""}|${config.model}`;
        const cached = getCachedProbeResult(cacheK);
        const passed =
          cached !== undefined
            ? cached
            : await probeReasoningSupport(llmProvider, reasoningStrategy);
        // Only cache a definitive result — a transient probe error (null) must
        // NOT pin "reasoning not supported" for the 24h TTL.
        if (cached === undefined && passed !== null) setCachedProbeResult(cacheK, passed);
        logger.logSilent(
          "info",
          t("env.reasoning_probe", {
            strategy: reasoningStrategy,
            result: passed === true ? t("env.reasoning_respected") : t("env.reasoning_ignored"),
          }),
        );
        // null (transient error) falls back to "not passed" for this session.
        return passed === true;
      } catch {
        return false;
      }
    })();
  }

  const baseDir = projectDir ? resolve(projectDir) : process.cwd();

  // Cross-device diagnosis: log a full environment report (OS, runtime,
  // engines, PATH tools, provider/retry, playwright) at every startup.
  const envReport = collectEnvironment({
    configDir: dir,
    baseDir,
    config,
    scanTools: process.env.NODE_ENV !== "test",
  });
  logEnvironment(envReport, logger);
  for (const warning of envReport.warnings) {
    logger.warn(warning);
  }

  const projectMapCacheDir = join(baseDir, ".mma");
  const indexerModule = new IndexerModule({
    baseDir,
    cacheDir: projectMapCacheDir,
  });
  try {
    // Build (or load from cache) the project index. On a large workspace the
    // first walk can pause startup with no other output — announce both ends
    // so the silence is explained.
    logger.info(t("env.indexing"));
    const index = await indexerModule.buildIndex();
    if (index) {
      logger.info(t("env.indexed", { files: String(index.files.length) }));
    } else {
      logger.warn(t("env.indexing_failed", { error: "no index produced" }));
    }
  } catch (err: any) {
    logger.warn(t("env.indexing_failed", { error: String(err?.message ?? err) }));
  }

  const skillsLoader = new SkillsLoader();
  const builtinDir = join(import.meta.dirname, "skills", "builtin");
  const globalDir = join(homedir(), ".agents", "skills");
  const projectSkillsDir = join(baseDir, ".mma", "skills");
  const availableSkills = skillsLoader.loadFromAllSources(builtinDir, globalDir, projectSkillsDir);

  const skillsBudget = Math.floor(config.contextWindow * config.skills.budget);
  const skillsModule = new SkillsModule(availableSkills, skillsBudget);

  const toolRegistry = new ToolRegistry();
  registerAllTools(toolRegistry, skillsModule, {
    enableOnDemand: config.tools?.enableOnDemand,
  });

  const pluginManager = new PluginManager();

  const systemInfoContent = buildSystemInfo(config, baseDir, profile.compress());
  const systemInfoPrompt: PromptBlock = {
    content: systemInfoContent,
    priority: "critical",
    essential: true,
    estimatedTokens: estimateTokens(systemInfoContent),
  };

  const sessionDir = join(dir, "sessions");
  const sessionStore = new SessionStore(sessionDir, config.security?.sessionEncryption);
  sessionStore.init();
  // Archive >30-day sessions (gzip history + mark rotated). This was dead code
  // — never invoked, so old sessions were never compressed. Deferred so the
  // (synchronous) compression never delays startup; failures are non-fatal.
  setTimeout(() => {
    try {
      sessionStore.rotateOldSessions();
    } catch (err) {
      logger.warn(`session rotation failed: ${String(err)}`);
    }
  }, 0);
  const sessionManager = new SessionManager(sessionStore, {
    model: config.model,
    contextWindow: config.contextWindow,
    projectDir: baseDir,
    maxSessions: config.session.maxSessions,
    isolation: config.sessionIsolation,
  });
  activeSessionManager = sessionManager;

  if (config.session.autoSave && !sessionManager.getActive()) {
    sessionManager.create();
  }

  // Persist the context probe to the session as soon as it resolves, in BOTH
  // interactive and one-shot modes. Previously only the REPL wrote this entry,
  // so one-shot runs lost the loaded-vs-configured context mismatch entirely
  // (observed: LM Studio loaded 86016 while contextWindow was 32768 — silent).
  void contextProbePromise
    .then((probe) => {
      if (!probe) return;
      try {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "context_probe",
          content: `model=${probe.model} actual=${probe.actual} configured=${config.contextWindow}`,
        });
      } catch {
        // best-effort
      }
    })
    .catch(() => {});

  // Git-style context log (opt-in via --context-log / config / env). Written
  // next to the session files so it travels with the session. Best-effort:
  // logging must never break a run.
  const contextLogEnabled = contextLog === true || config.contextLog?.enabled === true;
  let contextLogger: ContextLogger | undefined;
  if (contextLogEnabled) {
    const activeMeta = sessionManager.getActiveMeta();
    if (activeMeta) {
      try {
        contextLogger = new ContextLogger({
          path: join(sessionStore.getSessionDir(activeMeta.id), "context.diff"),
          sessionId: activeMeta.id,
          model: config.model,
          contextWindow: config.contextWindow,
          redact: config.contextLog?.redact !== false,
        });
      } catch (err) {
        logger.warn(t("error.context_log_init", { error: errMsg(err) }));
        contextLogger = undefined;
      }
    }
  }

  const tokenCounter = new TokenCounter(config.model);

  // Mutable set of active tool tags, shared between the agent loop and the
  // `enable_tools` tool. The loop re-reads it every iteration to recompute the
  // LLM-visible tool set; enable_tools pushes tags into it. When on-demand
  // enabling is disabled the tag set stays empty, which restores the legacy
  // all-tools behavior (getAllForLLM returns everything for empty tags).
  const enableOnDemand = config.tools?.enableOnDemand !== false;
  const activeToolTags: string[] = enableOnDemand
    ? config.tools?.defaultTags
      ? [...config.tools.defaultTags]
      : []
    : [];

  const contextManager = new ContextManager(
    config.contextWindow,
    config.contextBudget,
    tokenCounter,
  );

  // Shared box for the LIVE config. `Agent.reconfigure` replaces deps.config
  // AND this box, so anything that captured the reference at bootstrap —
  // toolCtx.config, security validators, tool rules — keeps seeing the CURRENT
  // settings after /model use or the wizard. Pinning the value once meant
  // tools enforced the pre-reconfigure security/maxTool settings all session.
  const configRef: { current: AppConfig } = { current: config };

  const toolCtx = {
    baseDir,
    logger,
    exitOnComplete,
    contextManager,
    activeToolTags,
    recursionDepth: 0,
    fileOperationsCount: 0,
    sessionHistory: {
      append: async (type: string, content: unknown) => {
        const meta = sessionManager.getActiveMeta();
        if (!meta) return;
        sessionManager.appendMessage({
          role: "tool",
          content: typeof content === "string" ? content : JSON.stringify(content),
          name: type,
          timestamp: new Date().toISOString(),
        });
      },
    },
    sessionLog: {
      plan: (event: string, detail: string, iteration?: number) => {
        sessionManager.appendLog({
          ts: new Date().toISOString(),
          type: "plan",
          tool: event,
          content: detail,
          ...(iteration !== undefined ? { iteration } : {}),
        });
      },
    },
  } as ToolContext;

  // `config` is exposed as a LIVE getter over the shared configRef so tools
  // and security validators see the CURRENT settings after a reconfigure.
  Object.defineProperty(toolCtx, "config", {
    get: () => configRef.current,
    configurable: true,
  });

  // `sessionId`/`sessionContext` are exposed as LIVE getters over the session
  // manager instead of being captured once at bootstrap. Capturing the values
  // pinned them to the session active at startup, so after a REPL /new or
  // /resume the new session's audit.jsonl entries were tagged with the
  // PREVIOUS session's id (observed: ses_msyghz8w audit entries carrying
  // ses_msyg892p_78kqhc) while sessionHistory kept reading the live meta.
  // Everything that consumes ctx.sessionId — audit log, process registry,
  // file-ops counters — now always sees the session that is actually active.
  Object.defineProperty(toolCtx, "sessionId", {
    get: () => sessionManager.getActiveMeta()?.id,
    configurable: true,
  });
  Object.defineProperty(toolCtx, "sessionContext", {
    get: () => sessionManager.getSessionContext() ?? undefined,
    configurable: true,
  });
  Object.defineProperty(toolCtx, "sessionManager", {
    get: () => sessionManager,
    configurable: true,
  });
  // Возможности активной модели — LIVE: пресет провайдера + native-probe +
  // конфиг-оверрайд пересчитываются при каждом обращении тула, поэтому
  // инструменты (browser и т.п.) видят актуальный vision/tools после
  // смены модели или /provider use.
  Object.defineProperty(toolCtx, "capabilities", {
    get: () => {
      const cfg = configRef.current;
      const spec = BUILTIN_PROVIDERS.find((p) => p.type === cfg.provider.type);
      return resolveModelCapabilities(
        spec?.capabilities,
        capabilitiesRef.probe,
        cfg.modelCapabilities?.[cfg.model],
      );
    },
    configurable: true,
  });

  const toolExecutor = new ToolExecutor(toolRegistry, toolCtx, pluginManager);
  toolCtx.llmProvider = llmProvider;
  toolCtx.toolExecutor = toolExecutor;

  const hallucinationDetector = new HallucinationDetector(baseDir, llmProvider, {
    judgeEnabled: config.hallucination?.judge?.enabled ?? false,
  });

  const moduleRegistry = new ModuleRegistry();

  const execModule = new ExecutionModule(
    baseDir,
    config.stuckThreshold,
    config.errorWebSearch?.threshold ?? 5,
  );
  // A plan in .mma/plans/active.json is PROJECT state, not session state —
  // restore it in every session so `plan show` works and the checklist is
  // visible. Nothing is printed unprompted: the REPL renders the checklist
  // only on plan/todo tool events.
  execModule.restorePlan();
  moduleRegistry.register(execModule);
  execModule.setHallucinationDetector(hallucinationDetector);

  const sessionModule = new SessionModule(sessionManager);
  moduleRegistry.register(sessionModule);

  moduleRegistry.register(indexerModule);

  const mcpModule = new MCPModule(config);
  try {
    // Bound the MCP init so one slow/hung MCP server can't block boot forever
    // (B5): on timeout, log-and-continue — MCP tools appear late or not at all
    // instead of stalling startup.
    await withTimeout(mcpModule.initialize(), 10_000);
  } catch (err) {
    logger.warn(
      `MCP init failed or timed out (${err instanceof Error ? err.message.slice(0, 120) : String(err)}) — continuing without MCP tools.`,
    );
  }
  moduleRegistry.register(mcpModule);

  const memoryStore = new MemoryStore(join(dir, "memory"));
  const memoryModule = new MemoryModule(memoryStore);
  moduleRegistry.register(memoryModule);

  if (config.browser.enabled) {
    const browserModule = new BrowserModule();
    moduleRegistry.register(browserModule);
    registerBuiltinPlugin(pluginManager, browserModule.getPlugin());
  }

  const lspLogger = new FileOnlyLogger(logger);
  const lspModule = new LspModule(config.lsp, undefined, lspLogger);
  moduleRegistry.register(lspModule);
  registerBuiltinPlugin(pluginManager, lspModule.getPlugin());

  // Startup health check: scan project for existing errors so the model
  // knows the baseline before it starts working. Skip for one-shot runs and
  // test environments. Started in the background (never awaited) so the REPL
  // banner is not blocked by `npx tsc` on the whole project; the Agent awaits
  // it before the first LLM call via `lazyPromptBlocks` (already resolved by
  // the time the user types in the interactive REPL).
  let startupCheckBlock: PromptBlock | null = null;
  const startupCheckPromise =
    !oneShotMode && !exitOnComplete && process.env.NODE_ENV !== "test"
      ? runStartupHealthCheck(config.lsp ?? DEFAULT_LSP_CONFIG, baseDir, { logger: lspLogger })
      : Promise.resolve(null);

  const moduleTools = moduleRegistry.collectToolDefinitions();
  for (const tool of moduleTools) {
    toolRegistry.register(tool);
  }

  const plugin = execModule.getPlugin();
  registerBuiltinPlugin(pluginManager, plugin);

  registerBuiltinPlugin(pluginManager, sessionModule.getPlugin());

  registerBuiltinPlugin(pluginManager, skillsModule.getPlugin());

  registerBuiltinPlugin(pluginManager, indexerModule.getPlugin());

  registerBuiltinPlugin(pluginManager, mcpModule.getPlugin());

  pluginManager.register(lintOnWritePlugin);
  pluginManager.register(notifyPlugin);

  const pluginLoader = new PluginLoader();
  const globalPluginsDir = join(homedir(), ".mma", "plugins");
  const projectPluginsDir = join(baseDir, ".mma", "plugins");
  const mmaVersion = readMmaVersion();
  pluginLoader.loadFromDir(globalPluginsDir, pluginManager, logger, {
    source: "global",
    mmaVersion,
  });
  pluginLoader.loadFromDir(projectPluginsDir, pluginManager, logger, {
    source: "project",
    mmaVersion,
  });

  contextManager.onCompact = (summary) => {
    const meta = sessionManager.getActiveMeta();
    if (!meta || !config.session.autoSave) return;
    sessionManager.appendMessage({
      role: summary.role,
      content: summary.content,
      name: summary.name,
      timestamp: new Date().toISOString(),
    });
  };

  // Carry the active plan (id, progress, current step) into the compaction
  // summary so a 9B model doesn't re-create the plan from scratch right after
  // compaction (observed: ses_msvuao0h — plan_e07pb2 (1/6) discarded for a
  // fresh plan_xzq9xe the same iteration the old plan was still visible).
  contextManager.setPlanSummaryProvider(() => execModule.getPlanSummary());

  const agentsMdBlocks = loadAgentsMdBlocks(baseDir, dir, noAgentsMd === true);

  const promptBlocks: PromptBlock[] = [
    systemInfoPrompt,
    ...moduleRegistry.collectPromptBlocks(["indexer", "session"]),
    ...agentsMdBlocks,
    // Static plan reminder: always present so the model knows to check for an
    // active plan before creating a new one (even on the first iteration before
    // the <system-summary> envelope appears).
    {
      content:
        "[Plan Reminder] An active plan may exist for this session. Before creating a new plan, check with `plan show`. If a plan is active, continue it — do NOT create a new plan.",
      priority: "high",
      essential: false,
      estimatedTokens: 50,
    },
  ];

  // Startup overflow warning (banner, A3): dry-run the system-prompt budget
  // with the same block set the Agent's first build will use (static + skills
  // + project map + hidden tools) and surface instructions/project-map blocks
  // that will not fit. The Agent compresses them before the first LLM call;
  // this warning tells the USER why and how to get the full text included.
  {
    const dynamicBlocks: PromptBlock[] = [];
    const skillsBlock = skillsModule.getSystemPromptBlock();
    if (skillsBlock) dynamicBlocks.push(skillsBlock);
    const mapBlock = indexerModule.getSystemPromptBlock();
    if (mapBlock) dynamicBlocks.push(mapBlock);
    const hiddenToolsBlock = buildHiddenToolsBlock(toolRegistry.getAll(), activeToolTags);
    if (hiddenToolsBlock) {
      dynamicBlocks.push({
        content: hiddenToolsBlock,
        priority: "low",
        essential: false,
        estimatedTokens: estimateTokens(hiddenToolsBlock),
      });
    }
    const systemBudget = Math.floor(config.contextWindow * config.contextBudget.systemPrompt);
    const dry = dryRunOverflow([...promptBlocks, ...dynamicBlocks], systemBudget);
    if (dry.overflow.length > 0) {
      const overflowTokens = dry.overflow.reduce((s, b) => s + b.estimatedTokens, 0);
      const needed = dry.includedTokens + overflowTokens;
      const hint = overflowHint(config, dir, needed);
      for (const b of dry.overflow) {
        logger.warn(
          t("prompt.overflow.startup", {
            block: b.kind === "instructions" ? "AGENTS.md" : "project map",
            original: String(b.estimatedTokens),
            needed: String(needed),
            budget: String(systemBudget),
            hint,
          }),
        );
      }
    }
  }

  const agentDeps: AgentDeps = {
    config,
    configRef,
    llmProvider,
    getProviderName: () => providerManager.activeName,
    toolExecutor,
    pluginManager,
    contextManager,
    hallucinationDetector,
    logger,
    baseDir,
    configDir: dir,
    toolTags: activeToolTags,
    promptBlocks,
    envReport,
    getDynamicPromptBlocks: () => {
      const blocks: PromptBlock[] = [];
      // Plan block removed: it mutates every iteration (step status changes),
      // invalidating the local KV-cache. The plan status is now injected into
      // the <system-summary> envelope after each tool batch instead.
      const skillsBlock = skillsModule.getSystemPromptBlock();
      if (skillsBlock) blocks.push(skillsBlock);
      // Session metadata (id/name/model/context) is collected here, not at
      // bootstrap: the session is created during bootstrap with messageCount 0,
      // so a static collect would always yield null. Content is stable per
      // session (no per-turn fields) to preserve prefix KV-cache.
      const sessionBlock = sessionModule.getSystemPromptBlock();
      if (sessionBlock) blocks.push(sessionBlock);
      const mapBlock = indexerModule.getSystemPromptBlock();
      if (mapBlock) blocks.push(mapBlock);
      const hiddenToolsBlock = toolCtx.toolAllowlist
        ? null
        : buildHiddenToolsBlock(toolRegistry.getAll(), activeToolTags);
      if (hiddenToolsBlock) {
        blocks.push({
          content: hiddenToolsBlock,
          priority: "low",
          essential: false,
          estimatedTokens: estimateTokens(hiddenToolsBlock),
        });
      }
      return blocks;
    },
    finalAudit: () => execModule.runFinalAudit(),
    lazyPromptBlocks: async () => {
      if (startupCheckBlock) return [startupCheckBlock];
      startupCheckBlock = (await startupCheckPromise) ?? null;
      return startupCheckBlock ? [startupCheckBlock] : [];
    },
    sessionManager,
    memoryStore,
    moduleRegistry,
    exitOnComplete,
    contextLogger,
    reasoningProbe: () => reasoningProbePromise,
    reasoningStrategy,
    planSummary: () => execModule.getPlanSummary(),
    toolCtx,
  };

  const agent = new Agent(agentDeps);

  // Register set_thinking tool (needs agent's shared reasoning state)
  if (config.reasoning) {
    const { createSetThinkingTool } = await import("../tools/set-thinking");
    const setThinkingTool = createSetThinkingTool(
      agent.reasoningState,
      config.reasoning,
      () => agent.currentIteration,
    );
    toolRegistry.register(setThinkingTool);
  }

  return {
    agent,
    config,
    logger,
    sessionManager,
    skillsModule,
    pluginManager,
    execModule,
    toolCtx,
    toolRegistry,
    configDir: dir,
    baseDir,
    noAgentsMd: noAgentsMd === true,
    envReport,
    legacyDetected,
    contextProbe: contextProbePromise,
    memoryStore,
    indexerModule,
  };
}
