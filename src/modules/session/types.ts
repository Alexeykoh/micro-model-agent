// Типы сессий: мета, сообщения, security-оверрайды.
import type { ContentPart } from "../../llm/provider";

/** Мета сессии. */
export interface SessionMeta {
  id: string;
  name: string;
  /** Происхождение `name`: дефолтное по дате, авто или ручное. */
  nameSource?: "default" | "auto" | "manual";
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model: string;
  contextWindow: number;
  projectDir: string;
  /** История заархивирована в <id>.jsonl.gz через rotateOldSessions — живых сообщений нет. */
  rotated?: boolean;
  /** Security-оверрайды сессии: перекрывают глобальные настройки. */
  securityOverrides?: {
    maxFileOperations?: number;
    maxRecursionDepth?: number;
    rateLimits?: {
      maxRequestsPerMinute?: number;
      maxParallelTasks?: number;
    };
  };
}

/** Сообщение сессии (роль, контент, tool_calls, провенанс провайдера/модели). */
export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  timestamp: string;
  /** Провайдер, обслуживший сообщение (мультипровайдерный режим). */
  provider?: string;
  /** Модель, обслужившая сообщение. */
  model?: string;
}
