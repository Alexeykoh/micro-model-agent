/**
 * Тул git: argv-исполнение БЕЗ шелла, классификация read/mutate/destructive,
 * destructive — через одноразовое разрешение `approve` (спека
 * `2026-06-08-git-workflow-design` §5). Шелл-мета символы физически не
 * попадают в команду, `-C`/`--git-dir`/`-c` blocked jail-гейтом в `git-core`.
 *
 * Egress-гейт push: адресат через `checkOutboundUrl`, незапушенный дифф —
 * через `detectSecrets` (спека `2026-11-09-git-push-egress-design`).
 */
import { resolve } from "node:path";
import { t } from "../i18n/index";
import { assertWorkdirAllowed } from "./path-guards";
import { safeResolvePath } from "./path-utils";
import { classifyGitArgv, gitCommandName, gitSubcommand } from "./git-classes";
import { capDiff, runGit } from "./git-core";
import { extractPushRemote, resolvePushUrl, unpushedDiff } from "./git-push-egress";
import { checkOutboundUrl } from "../modules/security/outbound-policy";
import { detectSecrets } from "../modules/security/data-policy/detectors/secrets";
import type { ToolDefinition, ToolContext, ToolResult } from "./types";

/** Субкоманды, которым нужен сетевой бюджет (fetch/pull/push идут дольше локальных). */
const NETWORK_SUBS = new Set(["fetch", "pull", "push", "clone", "ls-remote", "credential", "http-fetch", "http-push", "send-email", "request-pull"]);

/** Дефолтный лимит строк вывода (boundedOutput: тул режет сам). */
const DEFAULT_LINES = 200;

/** Оборонительный доступ к мемо исполнителя (стабы могут не иметь методов, как в bash-memo). */
function memoGet(ctx: ToolContext, args: Record<string, unknown>): ToolResult | undefined {
  const get = ctx.toolExecutor?.memoGet;
  return typeof get === "function" ? get.call(ctx.toolExecutor, "git", args) : undefined;
}
function memoSet(ctx: ToolContext, args: Record<string, unknown>, result: ToolResult): void {
  const set = ctx.toolExecutor?.memoSet;
  if (typeof set === "function") set.call(ctx.toolExecutor, "git", args, result);
}
function memoInvalidate(ctx: ToolContext): void {
  const clear = ctx.toolExecutor?.memoInvalidate;
  if (typeof clear === "function") clear.call(ctx.toolExecutor);
}

/** Хвост `-- <file>` для субкоманд, которым он адресно полезен. */
const FILE_TAIL_SUBS = new Set(["diff", "log", "show", "blame", "diff-files", "diff-index", "status"]);

function buildArgv(args: Record<string, unknown>): string[] {
  const sub = String(args.subcommand ?? "").trim().toLowerCase();
  const raw = Array.isArray(args.args) ? args.args : [];
  const extra = raw.map((a) => String(a)).filter((a) => a.length > 0);
  const file = typeof args.file === "string" && args.file.trim() ? args.file.trim() : undefined;
  if (file && FILE_TAIL_SUBS.has(sub)) extra.push("--", file);
  return [sub, ...extra];
}

/** Ограничение вывода по строкам (0 — без лимита). */
function capLines(output: string, lines: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(lines) || lines <= 0) return { text: output, truncated: false };
  const parts = output.split("\n");
  if (parts.length <= lines) return { text: output, truncated: false };
  return {
    text: `${parts.slice(0, lines).join("\n")}\n…${t("git.truncated", { shown: lines, total: parts.length })}`,
    truncated: true,
  };
}

export const gitTool: ToolDefinition = {
  name: "git",
  icon: "🌿",
  tags: ["shell", "code"],
  security: {
    caps: [{ proc: true }],
    manual: {
      reason: "git: классификация субкоманд и approve destructive живут в хендлере (argv без шелла, jail в git-core)",
      reviewedBy: "git-workflow-design",
      date: "2026-06-08",
    },
  },
  boundedOutput: true,
  manualMemo: true,
  timeoutMs: 60_000,
  description:
    "Run git in the workspace WITHOUT a shell: subcommand + argv array (no pipes/redirections possible). " +
    "Classes: read (status/log/diff/…, memoized), mutate (add/commit/checkout/…), destructive " +
    "(push --force, reset --hard, clean -f, branch -D, commit --amend, stash drop, …) — a destructive call is " +
    "refused until the user approves it: call approve with action=\"git <exact command>\" and path=\".\", then retry. " +
    "Flags -C/-c/--git-dir/--work-tree/--exec-path are blocked. For diffs prefer stat:true (summary) or file:<path> " +
    "(one file) — output is capped at lines (default 200).",
  parameters: {
    type: "object",
    properties: {
      subcommand: {
        type: "string",
        description: "Git subcommand without the leading `git` (e.g. 'status', 'diff', 'commit')",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments/flags as separate tokens (e.g. ['--oneline', '-10']). No shell syntax.",
      },
      file: {
        type: "string",
        description: "Workspace-relative path for path-scoped commands (diff/log/show/blame/status)",
      },
      stat: {
        type: "boolean",
        description: "diff only: prepend --stat summary (keeps hunks after it unless too large)",
      },
      lines: {
        type: "number",
        description: "Max output lines (default 200, 0 = unlimited)",
      },
      workdir: {
        type: "string",
        description: "Working directory inside the workspace (default: workspace root)",
      },
    },
    required: ["subcommand"],
  },
  handler: async (ctx, args) => {
    const sub = String(args.subcommand ?? "").trim();
    if (!sub || sub.includes(" ") || /[^\w-]/.test(sub)) {
      return {
        success: false,
        output: `Invalid subcommand "${sub}" — a single word without shell syntax (e.g. "status", "commit").`,
      };
    }
    const argv = buildArgv({ ...args, subcommand: sub });
    const cls = classifyGitArgv(argv);
    const name = gitCommandName(argv);
    const memoKey = { subcommand: sub, args: args.args ?? [], file: args.file ?? null, stat: !!args.stat };

    // read — повторы отдают из мемо (TTL исполнителя), как у bash read-only.
    if (cls === "read") {
      const hit = memoGet(ctx, memoKey);
      if (hit) return hit;
    }

    const workdir = safeResolvePath(ctx.baseDir, String(args.workdir ?? "."));
    const jail = assertWorkdirAllowed(ctx, workdir);
    if (jail) return jail;

    // egress-гейт push (оплата долга git-push-egress-ungated): адресат + секреты.
    if (sub === "push") {
      const remote = extractPushRemote(argv);
      const url = await resolvePushUrl(workdir, remote);
      if (!url) {
        return {
          success: false,
          blocked: true,
          output: `git push blocked: no remote configured and no explicit remote given (egress policy).`,
          errorMeta: { code: "git_push_no_remote", retryable: false },
        };
      }
      const outbound = checkOutboundUrl(url, "tool:git", {
        networkConfig: ctx.config.security?.network,
        operation: "git.push",
      });
      if (!outbound.allowed) {
        return {
          success: false,
          blocked: true,
          output: `git push blocked by outbound policy: ${outbound.reason ?? "URL not allowed"} (${url})`,
          errorMeta: { code: "git_push_egress_blocked", retryable: false, hint: "set security.network.allowPrivateOutbound or use a public host" },
        };
      }
      const diff = await unpushedDiff(workdir);
      const findings = detectSecrets(diff);
      if (findings.length > 0) {
        const kinds = [...new Set(findings.map((f) => f.kind))].join(", ");
        return {
          success: false,
          blocked: true,
          output: `git push blocked: ${findings.length} secret finding(s) in unpushed commits (${kinds}). Remove them from history before pushing.`,
          errorMeta: { code: "git_push_secret_in_history", retryable: false },
        };
      }
    }

    // destructive — только по одноразовому разрешению `approve` (path=".").
    // Разрешение минтится хендлером approve и потребляется здесь по callId
    // (тот же механизм, что у защищённых путей).
    if (cls === "destructive") {
      const store = ctx.approvals;
      const grant = store?.consume(resolve(workdir), ctx.activeCallId ?? "");
      if (!grant) {
        return {
          success: false,
          blocked: true,
          output: `${t("git.approve_required", { command: name })}`,
          errorMeta: { code: "git_destructive_needs_approval", retryable: false, hint: `approve(action="${name}", path=".") then retry the exact command` },
        };
      }
    }

    // diff --stat: сначала сводка, хунки — только если влезли в бюджет строк.
    let result = await exec(ctx, argv, args, workdir, cls);
    if (args.stat && sub === "diff" && result.success) {
      const stat = await exec(ctx, ["diff", "--stat", ...argv.slice(1).filter((a) => a !== "--stat")], { ...args, stat: false }, workdir, "read");
      if (stat.success) {
        result = { ...result, output: `${stat.output}\n${result.output}` };
      }
    }

    if (cls === "read" && result.success) memoSet(ctx, memoKey, result);
    if (cls !== "read") memoInvalidate(ctx); // любая мутация сбрасывает read-мемо
    return result;
  },
};

/** Один запуск argv с обрезкой вывода и машинной сигнатурой в `data`. */
async function exec(
  ctx: ToolContext,
  argv: string[],
  args: Record<string, unknown>,
  workdir: string,
  cls: string,
): Promise<ToolResult> {
  const timeout = NETWORK_SUBS.has(argv[0]?.toLowerCase() ?? "") ? 50_000 : 15_000;
  const r = await runGit(workdir, argv, timeout);
  const sub = argv[0]?.toLowerCase() ?? "";
  const data = { class: cls, subcommand: gitSubcommand(argv) || sub, exitCode: r.code };

  if (r.blocked) {
    return {
      success: false,
      output: `git: ${r.blocked}`,
      data: { ...data, blocked: true },
      errorMeta: { code: "git_command_blocked", retryable: false },
    };
  }
  if (!r.ok && /not a git repository/.test(r.stderr)) {
    return {
      success: false,
      output: t("git.not_a_repo", { path: workdir }),
      data: { ...data, notARepo: true },
      errorMeta: { code: "git_not_a_repo", retryable: false, hint: "run the agent in a git workspace or init a repository" },
    };
  }
  if (r.timedOut) {
    return {
      success: false,
      output: `git ${argv.join(" ")} timed out after ${timeout / 1000}s (partial output above may be missing).`,
      data: { ...data, timedOut: true },
      errorMeta: { code: "git_timeout", retryable: true },
    };
  }

  let output = [r.stdout.replace(/\0/g, "\n").trimEnd(), r.stderr.trim()].filter(Boolean).join("\n");
  if (sub === "diff") output = capDiff(output, 4000).diff + (capDiff(output, 4000).truncated ? `\n…${t("git.diff_truncated")}` : "");
  const lines = capLines(output, typeof args.lines === "number" ? args.lines : DEFAULT_LINES);
  const ok = r.code === 0;
  return {
    success: ok,
    output: lines.text,
    data: { ...data, truncated: lines.truncated },
    ...(ok ? {} : { errorMeta: { code: "git_failed", retryable: false, hint: r.stderr.split("\n")[0] ?? "" } }),
  };
}
