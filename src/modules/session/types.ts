export interface SessionMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  model: string;
  contextWindow: number;
  projectDir: string;
  /**
   * Session-specific security overrides
   * If present, these override the global security settings for this session
   */
  securityOverrides?: {
    maxFileOperations?: number;
    maxRecursionDepth?: number;
    rateLimits?: {
      maxRequestsPerMinute?: number;
      maxParallelTasks?: number;
    };
  };
}

export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  timestamp: string;
}
