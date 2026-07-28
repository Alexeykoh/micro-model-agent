import type { LLMProvider, ChatMessage } from "../llm/provider.js";
import { LMStudioNative } from "../llm/lmstudio-native.js";
import { OpenAICompat } from "../llm/openai-compat.js";
import type { OutputRenderer } from "../ui/renderer.js";
import {
  logInfo,
  logDebug,
  logWarn,
  logLLMRequest,
  logLLMResponse,
} from "../logger.js";
import { getLLMConfig } from "../config/config.js";

export async function doChat(
  provider: LLMProvider,
  messages: ChatMessage[],
  renderer: OutputRenderer,
  signal?: AbortSignal,
  retries = 1,
  showThinking = false,
  caller: "main" | "subagent" = "main",
  maxTokens?: number,
): Promise<{ response: string; genTimeMs: number }> {
  let lastReasoningText = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    const startTime = performance.now();
    const fullText: string[] = [];
    let started = false;
    let reasoningBuf: string | false = false;
    let currentReasoning = "";
    let lastFinishReason: string | null = null;
    let reasoningChunksCount = 0;
    let contentChunksCount = 0;

    if (signal?.aborted) return { response: "", genTimeMs: 0 };

    const lastMsg = messages[messages.length - 1];
    logLLMRequest(
      provider.model,
      messages.length,
      lastMsg?.content || "",
      caller,
    );

    if (caller === "main") {
      renderer.setStreamRole?.("assistant");
    }

    renderer.writeSpinner();

    try {
      let buf = "";
      for await (const chunk of provider.chat(messages, {
        temperature: 0.7,
        signal,
        showThinking,
        enableThinking: true,
        max_tokens: maxTokens,
      })) {
        if (!chunk.content && !chunk.reasoning && !chunk.finish_reason)
          continue;

        if (chunk.finish_reason) {
          lastFinishReason = chunk.finish_reason;
        }

        if (chunk.content) {
          fullText.push(chunk.content);
          contentChunksCount++;
        }

        if (chunk.reasoning) {
          reasoningChunksCount++;
          currentReasoning += chunk.reasoning;
        }

        if (!chunk.content && !chunk.reasoning) continue;

        if (!started) {
          renderer.clearSpinner();
          started = true;
        }

        if (chunk.reasoning) {
          if (showThinking) {
            if (reasoningBuf === false) {
              renderer.writeNewline();
              renderer.writeDim("┈ reasoning ┈");
              reasoningBuf = "";
            }
            reasoningBuf += chunk.reasoning;
          }
          continue;
        }

        if (reasoningBuf !== false && typeof reasoningBuf === "string") {
          renderer.writeNewline();
          renderer.writeDim(reasoningBuf);
          reasoningBuf = false;
        }

        buf += chunk.content;

        while (buf.length > 0) {
          const tcStart = buf.indexOf("<tool_call>");
          const tcEnd = buf.indexOf("</tool_call>");

          if (tcStart === -1 && tcEnd === -1) {
            const clean = buf.replace(/@grounding\[файл:\s*[^\]]*\]\n?/g, "");
            if (clean) renderer.writeMarkdownChunk(clean);
            buf = "";
            break;
          }

          if (tcStart !== -1 && (tcEnd === -1 || tcStart < tcEnd)) {
            if (tcStart > 0) {
              const clean = buf
                .slice(0, tcStart)
                .replace(/@grounding\[файл:\s*[^\]]*\]\n?/g, "");
              if (clean) renderer.writeMarkdownChunk(clean);
            }
            buf = buf.slice(tcStart);
            const closeIdx = buf.indexOf("</tool_call>");
            if (closeIdx !== -1) {
              buf = buf.slice(closeIdx + "</tool_call>".length);
            }
            break;
          }

          if (tcEnd !== -1 && (tcStart === -1 || tcEnd < tcStart)) {
            const clean = buf
              .slice(0, tcEnd)
              .replace(/@grounding\[файл:\s*[^\]]*\]\n?/g, "");
            if (clean) renderer.writeMarkdownChunk(clean);
            buf = buf.slice(tcEnd + "</tool_call>".length);
          }
        }
      }
      if (reasoningBuf !== false && typeof reasoningBuf === "string") {
        renderer.writeNewline();
        renderer.writeDim(reasoningBuf);
      }
      if (currentReasoning) {
        lastReasoningText = currentReasoning;
      }
    } catch (e: any) {
      if (e.name === "AbortError") {
        logLLMResponse(
          provider.model,
          0,
          performance.now() - startTime,
          "Aborted",
          caller,
        );
        return { response: "", genTimeMs: 0 };
      }
      logLLMResponse(
        provider.model,
        0,
        performance.now() - startTime,
        e.message,
        caller,
      );
      renderer.writeError(`\n[LLM] ${e.message}`);

      const isNetworkError =
        !e.message?.includes("API ") && !e.message?.includes("status");
      if (isNetworkError && attempt < retries) {
        const delay = Math.min(2000 * (attempt + 1), 10000);
        renderer.writeWarning(
          `[LLM] Network error, retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${retries})`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      const providerHint =
        provider instanceof LMStudioNative
          ? "Check that LM Studio is running on localhost:1234"
          : provider instanceof OpenAICompat
            ? "Check that your API server is running and the API key is correct"
            : "Check that your LLM server is running";
      renderer.writeWarning(`[LLM] ${providerHint}`);
      return { response: "", genTimeMs: 0 };
    }

    const genTimeMs = performance.now() - startTime;
    const response = fullText.join("");
    renderer.commitMarkdown();

    if (response.trim()) {
      logLLMResponse(
        provider.model,
        response.length,
        genTimeMs,
        undefined,
        caller,
      );
      return { response, genTimeMs };
    }

    const reason = lastFinishReason ?? "unknown";
    logWarn(
      "DOCHAT",
      `empty response #${attempt + 1}: finish_reason=${reason}, reasoning_chunks=${reasoningChunksCount}, content_chunks=${contentChunksCount}`,
    );
    if (lastFinishReason === "length") {
      renderer.writeWarning(
        `  [empty response: model hit max_tokens during reasoning (${reasoningChunksCount} reasoning chunks, 0 content chunks)]`,
      );
    } else if (reasoningChunksCount > 0 && contentChunksCount === 0) {
      renderer.writeWarning(
        `  [empty response: model produced ${reasoningChunksCount} reasoning chunks but no content]`,
      );
    }

    if (attempt < retries) {
      renderer.writeDim(`[retry ${attempt + 1}/${retries}]`);
    }
  }

  const llmCfg = getLLMConfig();

  if (llmCfg.retryWithoutThinking && lastReasoningText.trim()) {
    logInfo(
      "DOCHAT",
      `retrying without thinking (had ${lastReasoningText.length} reasoning chars)`,
    );
    renderer.writeDim(`[retry without thinking]`);
    const retryResult = await doChatOnce(
      provider,
      messages,
      renderer,
      signal,
      false,
      showThinking,
      caller,
      maxTokens,
    );
    if (retryResult.response.trim()) {
      logInfo(
        "DOCHAT",
        `retry without thinking succeeded: ${retryResult.response.length} chars`,
      );
      return retryResult;
    }
  }

  if (lastReasoningText.trim()) {
    logInfo("DOCHAT", `emergency: forcing content with low temperature`);
    renderer.writeDim(`[emergency: forcing content with temperature=0.1]`);
    const emergencyMessages: ChatMessage[] = [
      ...messages,
      {
        role: "user",
        content:
          "[System] You MUST produce a response now. Do NOT use thinking tags. Reply with a tool call or a direct answer. Any response is better than empty.",
      },
    ];
    const emergencyResult = await doChatOnce(
      provider,
      emergencyMessages,
      renderer,
      signal,
      false,
      showThinking,
      caller,
      maxTokens,
      0.1,
    );
    if (emergencyResult.response.trim()) {
      logInfo(
        "DOCHAT",
        `emergency succeeded: ${emergencyResult.response.length} chars`,
      );
      return emergencyResult;
    }
  }

  if (llmCfg.fallbackToReasoning && lastReasoningText.trim()) {
    logInfo(
      "DOCHAT",
      `fallback: using reasoning as content (${lastReasoningText.length} chars)`,
    );
    renderer.writeWarning(`  [fallback: using reasoning as content]`);
    return { response: lastReasoningText, genTimeMs: 0 };
  }

  return { response: "", genTimeMs: 0 };
}

async function doChatOnce(
  provider: LLMProvider,
  messages: ChatMessage[],
  renderer: OutputRenderer,
  signal?: AbortSignal,
  enableThinking = true,
  showThinking = false,
  caller: "main" | "subagent" = "main",
  maxTokens?: number,
  temperature = 0.7,
): Promise<{ response: string; genTimeMs: number }> {
  const startTime = performance.now();
  const fullText: string[] = [];
  let started = false;

  if (signal?.aborted) return { response: "", genTimeMs: 0 };

  if (caller === "main") {
    renderer.setStreamRole?.("assistant");
  }

  renderer.writeSpinner();

  try {
    let buf = "";
    for await (const chunk of provider.chat(messages, {
      temperature,
      signal,
      showThinking,
      enableThinking,
      max_tokens: maxTokens,
    })) {
      if (!chunk.content && !chunk.finish_reason) continue;

      if (chunk.content) {
        fullText.push(chunk.content);
      }

      if (!chunk.content) continue;

      if (!started) {
        renderer.clearSpinner();
        started = true;
      }

      buf += chunk.content;

      while (buf.length > 0) {
        const tcStart = buf.indexOf("<tool_call>");
        const tcEnd = buf.indexOf("</tool_call>");

        if (tcStart === -1 && tcEnd === -1) {
          if (buf) renderer.writeMarkdownChunk(buf);
          buf = "";
          break;
        }

        if (tcStart !== -1 && (tcEnd === -1 || tcStart < tcEnd)) {
          if (tcStart > 0) {
            renderer.writeMarkdownChunk(buf.slice(0, tcStart));
          }
          buf = buf.slice(tcStart);
          const closeIdx = buf.indexOf("</tool_call>");
          if (closeIdx !== -1) {
            buf = buf.slice(closeIdx + "</tool_call>".length);
          }
          break;
        }

        if (tcEnd !== -1 && (tcStart === -1 || tcEnd < tcStart)) {
          renderer.writeMarkdownChunk(buf.slice(0, tcEnd));
          buf = buf.slice(tcEnd + "</tool_call>".length);
        }
      }
    }
  } catch (e: any) {
    if (e.name === "AbortError") {
      return { response: "", genTimeMs: 0 };
    }
    renderer.writeError(`\n[LLM] ${e.message}`);
    return { response: "", genTimeMs: 0 };
  }

  const genTimeMs = performance.now() - startTime;
  const response = fullText.join("");
  renderer.commitMarkdown();

  logLLMResponse(provider.model, response.length, genTimeMs, undefined, caller);
  return { response, genTimeMs };
}
