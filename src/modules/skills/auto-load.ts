/**
 * Хук `onBeforeThink`: автозагрузка релевантного скилла до первого вызова LLM
 * (S14). Вынесено из `module.ts`, чтобы не раздувать файл модуля и не трогать
 * ядро: хук вызывается до `refreshSystemPrompt()`, поэтому тело скилла
 * попадает в тот же первый system-блок, без правки промпта посередине хода.
 */
import { t } from "../../i18n/index";
import type { PluginHookContext } from "../types";
import type { LoadResult } from "./load-budget";
import type { SkillMeta } from "./loader";
import { matchSkillByMessage } from "./auto-match";

type Directive = (event: string, detail: string, iter?: number) => void;
type Meta = (chunk: string) => void;

export interface AutoLoadDeps {
  available(): SkillMeta[];
  isLoaded(name: string): boolean;
  load(name: string): LoadResult;
}

function userMessage(ctx: PluginHookContext): string {
  const raw: unknown = ctx.lastUserMessage;
  return typeof raw === "string" ? raw : "";
}

function emitMeta(ctx: PluginHookContext, text: string): void {
  const raw: unknown = ctx.onMeta;
  if (typeof raw === "function") (raw as Meta)(text);
}

function logDirective(ctx: PluginHookContext, text: string): void {
  const raw: unknown = ctx.sessionLog;
  if (!raw || typeof raw !== "object") return;
  const directive: unknown = (raw as { directive?: unknown }).directive;
  if (typeof directive !== "function") return;
  const iteration: unknown = ctx.iteration;
  (directive as Directive)("skill.auto_loaded", text, typeof iteration === "number" ? iteration : undefined);
}

/**
 * Загружает один скилл по явным совпадениям с сообщением. Бюджет, дедуп и
 * счётчики использования остаются в `SkillsModule` — хук только принимает решение.
 */
export function autoLoadSkill(ctx: PluginHookContext, deps: AutoLoadDeps): void {
  const message = userMessage(ctx);
  // Явный вызов тула — модель уже взяла управление, автозагрузка была бы
  // дублем и лишним хвостом промпта.
  if (!message || message.includes("load_skill")) return;

  const skill = matchSkillByMessage(message, deps.available());
  if (!skill || deps.isLoaded(skill.name)) return;

  const result = deps.load(skill.name);
  if (!result.success) return;

  const notice = t("skill.auto_loaded", { name: skill.name });
  emitMeta(ctx, notice);
  logDirective(ctx, notice);
}
