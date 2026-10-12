/**
 * `ModuleHost` — контракт модуля с ядром (INV-2/5/7/8).
 *
 * Владеет реестром модулей, их жизненным циклом и единым путём сбора
 * тулов/промпт-блоков/хуков. Раньше роль хоста размазывалась по bootstrap:
 * `initialize()` звался вручную, `teardown` не звался никем, тулы регистрировались
 * из пяти мест. Хост сводит это к одному владельцу.
 *
 * Границы W1: здесь lifecycle и сбор. Enforcement возможностей тула — W2,
 * объявленный `core/api`/переезд модулей — W4.
 */
import type { OutputBus } from "../output";
import type { Logger } from "../logger/app-logger";
import type { AppConfig } from "../config/types";
import type { ToolDefinition } from "../tools/types";
import type { RegisteredTool } from "../tools/registry";
import type { AgentPlugin } from "../modules/types";
import type { PromptBlock } from "./types";
import { MODULE_SETUP_TIMEOUT_MS } from "../config/timeouts";

/** Сводка состояния модуля для баннера и `session.jsonl` (INV-6). */
export interface ModuleHealth {
  status: "ok" | "degraded" | "failed";
  /** Причина, если не `ok` (INV-6: отказ ≠ отсутствие). */
  reason?: string;
}

/**
 * Типизированный доступ модуля к сервисам ядра. Растёт по мере перевода
 * модулей (W1.6/W4); в W1.1 — только то, что уже нужно хосту.
 */
export interface ModuleData {
  /** Единый реестр тулов ядра (INV-2): единственный путь регистрации. */
  toolRegistry?: import("../tools/registry").ToolRegistry;
}

/** Ролевой контекст модуля: то, что хост отдаёт на `setup()` (спека §3.3). */
export interface ModuleCtx<C = unknown> {
  /** Живой read-only конфиг. */
  config: AppConfig;
  /** Child-логер модуля: `source = module:<name>` (INV-13/INV-16). */
  logger: Logger;
  bus: OutputBus;
  data: ModuleData;
  /** Модуль-специфичное (DI); хост отдаёт, когда есть что передать. */
  extensions?: C;
}

/** Определение модуля: lifecycle + декларация вклада в систему. */
export interface ModuleDef<C = unknown> {
  name: string;
  /** Порядок инициализации: этот модуль требует, чтобы `requires` поднялись первыми. */
  requires?: readonly string[];
  /** true — падение `setup()` валит boot (INV-5). */
  critical?: boolean;
  /** Таймаут setup в мс; применяется хостом — единый владелец (INV-8). */
  setupTimeoutMs?: number;

  setup?(ctx: ModuleCtx<C>): Promise<void> | void;
  teardown?(): Promise<void> | void;
  /** Отказ не фатален: модуль живёт в degraded, и это видно. */
  health?(): ModuleHealth;

  tools?(): ToolDefinition[];
  promptBlocks?(): PromptBlock[] | null;
  hooks?(): AgentPlugin;
}

/** Ошибка жизненного цикла: неизвестная зависимость, цикл, падение critical. */
export class ModuleHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleHostError";
  }
}

/**
 * Топологическая сортировка по `requires` (Kahn). Бросает на неизвестную
 * зависимость и на цикл — молча неправильный порядок хуже явной ошибки.
 */
function topoSort(defs: ReadonlyMap<string, ModuleDef>): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const name of defs.keys()) {
    indegree.set(name, 0);
    dependents.set(name, []);
  }
  for (const [name, def] of defs) {
    for (const req of def.requires ?? []) {
      if (!defs.has(req)) {
        throw new ModuleHostError(`module "${name}" requires unknown module "${req}"`);
      }
      indegree.set(name, (indegree.get(name) ?? 0) + 1);
      dependents.get(req)!.push(name);
    }
  }
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  const order: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    order.push(name);
    for (const next of dependents.get(name)!) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== defs.size) {
    throw new ModuleHostError("module requires form a cycle");
  }
  return order;
}

/** Хост модулей: регистрация, setup/teardown, health, сбор вклада. */
export class ModuleHost {
  private readonly defs = new Map<string, ModuleDef>();
  private readonly healthMap = new Map<string, ModuleHealth>();
  private order: string[] | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly bus: OutputBus,
    private readonly data: ModuleData = {},
  ) {}

  /** Регистрирует модуль. Имя уникально; порядок — через `requires`. */
  register(def: ModuleDef): void {
    if (this.defs.has(def.name)) {
      throw new ModuleHostError(`module "${def.name}" already registered`);
    }
    this.defs.set(def.name, def);
    this.order = null; // инвалидируем порядок
  }

  /** Имена модулей в порядке инициализации. */
  initOrder(): string[] {
    return this.resolveOrder();
  }

  /** Сводка здоровья (для баннера/`session.jsonl`). */
  health(): Array<{ name: string; health: ModuleHealth }> {
    return [...this.defs.keys()].map((name) => ({
      name,
      health: this.healthMap.get(name) ?? this.moduleHealth(this.defs.get(name)!),
    }));
  }

  /**
   * Поднимает модули в порядке зависимостей. Падение `critical`-модуля
   * (ошибка или таймаут setup) бросает и валит boot (INV-5); отказ
   * некритичного — degraded, остальные продолжают.
   */
  async setup(): Promise<void> {
    for (const name of this.resolveOrder()) {
      const def = this.defs.get(name)!;
      try {
        await this.setupOne(def);
        this.healthMap.set(name, this.moduleHealth(def));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (def.critical) {
          throw new ModuleHostError(`critical module "${name}" failed to set up: ${reason}`);
        }
        this.healthMap.set(name, { status: "failed", reason });
        this.logger.warn(`module "${name}" failed to set up — continuing degraded: ${reason}`);
      }
    }
  }

  /** Гасит модули в обратном порядке инициализации (INV-7). */
  async dispose(): Promise<void> {
    const names = this.resolveOrder().slice().reverse();
    for (const name of names) {
      const def = this.defs.get(name)!;
      if (!def.teardown) continue;
      try {
        await def.teardown();
      } catch (err) {
        // Teardown-ошибка не должна мешать погасить остальные.
        this.logger.warn(
          `module "${name}" teardown failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Вклад модулей: тулы (в порядке инициализации, с владельцем, INV-1/2). */
  collectTools(): RegisteredTool[] {
    const tools: RegisteredTool[] = [];
    for (const name of this.resolveOrder()) {
      for (const tool of this.defs.get(name)!.tools?.() ?? []) {
        tools.push({ ...tool, owner: name });
      }
    }
    return tools;
  }

  /** Вклад модулей: промпт-блоки (у каждого проставляется `source = имя модуля`). */
  collectPromptBlocks(): PromptBlock[] {
    const blocks: PromptBlock[] = [];
    for (const name of this.resolveOrder()) {
      for (const block of this.defs.get(name)!.promptBlocks?.() ?? []) {
        // Владелец блока — модуль (INV-1/17), как в `ModuleRegistry`.
        if (!block) continue;
        blocks.push(block.source ? block : { ...block, source: name });
      }
    }
    return blocks;
  }

  /** Вклад модулей: плагины-хуки. */
  collectHooks(): AgentPlugin[] {
    const hooks: AgentPlugin[] = [];
    for (const name of this.resolveOrder()) {
      const hook = this.defs.get(name)!.hooks?.();
      if (hook) hooks.push(hook);
    }
    return hooks;
  }

  private resolveOrder(): string[] {
    if (!this.order) this.order = topoSort(this.defs);
    return this.order;
  }

  private async setupOne(def: ModuleDef): Promise<void> {
    if (!def.setup) return;
    const ctx = this.ctxFor(def);
    const timeoutMs = def.setupTimeoutMs ?? MODULE_SETUP_TIMEOUT_MS;
    await withTimeout(Promise.resolve(def.setup(ctx)), timeoutMs, def.name);
  }

  private ctxFor(def: ModuleDef): ModuleCtx {
    return {
      config: this.config,
      // INV-13: логер модуля несёт источник `module:<name>` (W0.2).
      logger: this.logger.child(def.name),
      bus: this.bus,
      data: this.data,
    };
  }

  private moduleHealth(def: ModuleDef): ModuleHealth {
    return def.health?.() ?? { status: "ok" };
  }
}

/**
 * Минимальная поверхность реестра тулов для единственной точки записи (INV-2).
 * Структурная: раннерный/веб-реестр подходит без импорта `ToolRegistry`.
 */
export interface ToolRegistrySink {
  register(tool: ToolDefinition, owner: string): void;
}

/** Реестр, умеющий заменить тул по имени (вклад плагинов). */
export interface ToolRegistryUpsertSink {
  upsert(tool: ToolDefinition, owner: string): void;
}

/**
 * Единственная точка записи тулов в систему (INV-2). Любая регистрация —
 * ядровая, модульная, раннерная, интерактивная — проходит здесь: владелец
 * приходит извне, а сам вызов `register` существует только в этом файле.
 * Инвариант стережёт `tests/arch/tool-registration.test.ts` (AST, без allowlist).
 */
export function registerOwnedTools(
  sink: ToolRegistrySink,
  entries: ReadonlyArray<{ tool: ToolDefinition; owner: string }>,
): void {
  for (const { tool, owner } of entries) sink.register(tool, owner);
}

/** Замена тула по имени через ту же точку записи (выгрузка/перезагрузка плагинов). */
export function upsertOwnedTool(
  sink: ToolRegistryUpsertSink,
  tool: ToolDefinition,
  owner: string,
): void {
  sink.upsert(tool, owner);
}

/** Ограничивает промис таймаутом с внятной ошибкой (INV-8). */
function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ModuleHostError(`module "${name}" setup timed out after ${ms}ms`)),
      ms,
    );
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
