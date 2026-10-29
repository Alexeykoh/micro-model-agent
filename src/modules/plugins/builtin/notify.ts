// Built-in `notify` plugin: a desktop notification when an agent turn ends.
//
// This used to be a stub that only wrote a debug line on session end, so the
// toggle in Settings did nothing in both CLI and web. The correct hook is
// `onTurnEnd` (one notification per completed/aborted turn), not `onSessionEnd`
// (which only fires when the whole runner stops).
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { t } from "../../../i18n/index";
import type { AgentPlugin, TurnSummary } from "../../types";
import type { ToolContext } from "../../../tools/types";

/** Injectable notifier (tests never touch the real OS). */
export type DesktopNotifier = (
  title: string,
  body: string,
  onError?: (err: Error) => void,
) => void;

/** A command that shows a native notification, or null on unsupported OS. */
export function notificationCommand(
  plat: NodeJS.Platform,
  title: string,
  body: string,
): { cmd: string; args: string[] } | null {
  if (plat === "darwin") {
    return {
      cmd: "osascript",
      args: ["-e", `display notification "${dquote(body)}" with title "${dquote(title)}"`],
    };
  }
  if (plat === "linux") return { cmd: "notify-send", args: [title, body] };
  if (plat === "win32") {
    return {
      cmd: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-WindowStyle",
        "Hidden",
        "-Command",
        windowsToastScript(title, body),
      ],
    };
  }
  return null;
}

/** Best-effort native notification; failures are reported to the caller. */
export function sendDesktopNotification(
  title: string,
  body: string,
  onError?: (err: Error) => void,
): void {
  const command = notificationCommand(platform(), title, body);
  if (!command) return;
  try {
    const child = spawn(command.cmd, command.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (err) => onError?.(err));
    child.unref();
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

export class NotifyPlugin implements AgentPlugin {
  name = "notify";
  priority = 5;
  isBuiltin = true;

  constructor(private readonly notifier: DesktopNotifier = sendDesktopNotification) {}

  onTurnEnd(ctx: ToolContext, summary: TurnSummary): void {
    const status = summary.interrupted
      ? t("plugin.notify_interrupted")
      : summary.success
        ? t("plugin.notify_done")
        : t("plugin.notify_failed");
    const body = t("plugin.notify_body", {
      status,
      seconds: (summary.durationMs / 1000).toFixed(1),
      tools: String(summary.toolCalls),
    });
    try {
      this.notifier("MMA", body, (err) => {
        ctx.logger?.debug?.(`notify failed: ${err.message}`);
      });
    } catch (err) {
      ctx.logger?.debug?.(`notify failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  onSessionEnd(ctx: ToolContext): void {
    const id = ctx.sessionId ?? "?";
    ctx.logger.debug?.(`Session ended: ${id}`);
  }
}

/** Powershell balloon via WinForms: no extra module, works on Windows 10/11. */
function windowsToastScript(title: string, body: string): string {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$n = New-Object System.Windows.Forms.NotifyIcon",
    "$n.Icon = [System.Drawing.SystemIcons]::Information",
    "$n.Visible = $true",
    `$n.ShowBalloonTip(5000, '${squote(title)}', '${squote(body)}', [System.Windows.Forms.ToolTipIcon]::Info)`,
    "Start-Sleep -Milliseconds 5500",
    "$n.Dispose()",
  ].join("; ");
}

function squote(text: string): string {
  return text.replace(/'/g, "''");
}

function dquote(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export const plugin = new NotifyPlugin();
