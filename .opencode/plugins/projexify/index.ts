import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugin } from "@opencode/plugin";
import {
  TOOL_DESCRIPTION,
  TOOL_INPUT_SCHEMA,
  buildRequest,
  formatResponse,
  resolveBaseURL,
  resolveToken,
  type ToolInput,
} from "./api";

const tokenFile = join(dirname(fileURLToPath(import.meta.url)), "token.txt");

function readTokenFile(): string {
  try {
    return readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default Plugin.define({
  id: "projexify",
  async setup(ctx) {
    const options = ctx.options as { token?: unknown; baseURL?: unknown };
    const baseURL = resolveBaseURL(options.baseURL ?? process.env.PROJEXIFY_BASE_URL);

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "projexify",
        description: "Projexify task tracker: projects, tasks, statuses and comments",
      });
      editor.add({
        name: "projexify_api",
        description: TOOL_DESCRIPTION,
        input: TOOL_INPUT_SCHEMA,
        options: { codemode: true },
        execute: async (rawInput, execCtx) => {
          // Read on every call so token rotation does not need a plugin reload.
          const token = resolveToken(options, process.env ?? {}, readTokenFile());
          if (!token) {
            return {
              content:
                "Projexify token is not configured. Put your pxt_ token in " +
                ".opencode/plugins/projexify/token.txt or set PROJEXIFY_TOKEN.",
            };
          }

          let request;
          try {
            request = buildRequest(rawInput as ToolInput);
          } catch (error) {
            return { content: `Invalid projexify call: ${errorText(error)}` };
          }

          const query = request.query ? `?${request.query}` : "";
          const headers: Record<string, string> = {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          };
          if (request.body) headers["Content-Type"] = "application/json";

          try {
            const response = await fetch(`${baseURL}${request.path}${query}`, {
              method: request.method,
              headers,
              body: request.body ? JSON.stringify(request.body) : undefined,
              signal: execCtx.signal,
            });
            return { content: formatResponse(response.status, await response.text(), token) };
          } catch (error) {
            if (execCtx.signal.aborted) return { content: "Projexify request cancelled" };
            return { content: `Projexify request failed: ${errorText(error)}` };
          }
        },
      });
    });
  },
});
