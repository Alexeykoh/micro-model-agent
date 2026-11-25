// Pure request/response logic for the projexify OpenCode plugin.
// No OpenCode SDK import here: the logic stays testable on its own.

export const API_PATH = "/api/v1/external";
export const DEFAULT_BASE_URL = "http://localhost:80";
const MAX_OUTPUT_CHARS = 12_000;

export interface ToolInput {
  action: string;
  projectId?: string;
  taskId?: string;
  /** userId | itemId | linkId — depending on the action. */
  targetId?: string;
  params?: Record<string, unknown>;
}

export interface RequestSpec {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: string;
  body?: Record<string, unknown>;
}

interface ActionSpec {
  method: RequestSpec["method"];
  ids: ("projectId" | "taskId" | "targetId")[];
  path: (projectId?: string, taskId?: string, targetId?: string) => string;
  fields?: string[];
  required?: string[];
  /** Human name of targetId in validation errors. */
  target?: string;
}

const enc = (value: string): string => encodeURIComponent(value);
const taskPath = (p?: string, t?: string): string => `/projects/${enc(p ?? "")}/tasks/${enc(t ?? "")}`;

const QUERY_FIELDS = ["q", "statusId", "assigneeId", "priority", "sortBy", "sortOrder", "limit", "skip"];
const TASK_CREATE_FIELDS = ["title", "description", "statusId", "priority", "dueDate", "estimatedTime"];
const TASK_UPDATE_FIELDS = ["title", "description", "priority", "dueDate", "estimatedTime"];

export const ACTIONS: Record<string, ActionSpec> = {
  "projects.list": { method: "GET", ids: [], path: () => "/projects" },
  "projects.get": { method: "GET", ids: ["projectId"], path: (p) => `/projects/${enc(p ?? "")}` },
  "projects.statuses": { method: "GET", ids: ["projectId"], path: (p) => `/projects/${enc(p ?? "")}/statuses` },
  "projects.members": { method: "GET", ids: ["projectId"], path: (p) => `/projects/${enc(p ?? "")}/members` },
  "tasks.list": {
    method: "GET",
    ids: ["projectId"],
    path: (p) => `/projects/${enc(p ?? "")}/tasks`,
    fields: QUERY_FIELDS,
  },
  "tasks.get": { method: "GET", ids: ["projectId", "taskId"], path: taskPath },
  "tasks.create": {
    method: "POST",
    ids: ["projectId"],
    path: (p) => `/projects/${enc(p ?? "")}/tasks`,
    fields: TASK_CREATE_FIELDS,
    required: ["title"],
  },
  "tasks.update": {
    method: "PATCH",
    ids: ["projectId", "taskId"],
    path: taskPath,
    fields: TASK_UPDATE_FIELDS,
  },
  "tasks.delete": { method: "DELETE", ids: ["projectId", "taskId"], path: taskPath },
  "tasks.setStatus": {
    method: "PATCH",
    ids: ["projectId", "taskId"],
    path: (p, t) => `${taskPath(p, t)}/status`,
    fields: ["statusId"],
    required: ["statusId"],
  },
  "tasks.assign": {
    method: "POST",
    ids: ["projectId", "taskId", "targetId"],
    path: (p, t, u) => `${taskPath(p, t)}/assignees/${enc(u ?? "")}`,
    target: "userId",
  },
  "tasks.unassign": {
    method: "DELETE",
    ids: ["projectId", "taskId", "targetId"],
    path: (p, t, u) => `${taskPath(p, t)}/assignees/${enc(u ?? "")}`,
    target: "userId",
  },
  "comments.list": {
    method: "GET",
    ids: ["projectId", "taskId"],
    path: (p, t) => `${taskPath(p, t)}/comments`,
  },
  "comments.add": {
    method: "POST",
    ids: ["projectId", "taskId"],
    path: (p, t) => `${taskPath(p, t)}/comments`,
    fields: ["content"],
    required: ["content"],
  },
  "checklist.add": {
    method: "POST",
    ids: ["projectId", "taskId"],
    path: (p, t) => `${taskPath(p, t)}/checklist`,
    fields: ["title"],
    required: ["title"],
  },
  "checklist.update": {
    method: "PATCH",
    ids: ["projectId", "taskId", "targetId"],
    path: (p, t, i) => `${taskPath(p, t)}/checklist/${enc(i ?? "")}`,
    fields: ["title", "checked"],
    target: "itemId",
  },
  "checklist.delete": {
    method: "DELETE",
    ids: ["projectId", "taskId", "targetId"],
    path: (p, t, i) => `${taskPath(p, t)}/checklist/${enc(i ?? "")}`,
    target: "itemId",
  },
  "links.add": {
    method: "POST",
    ids: ["projectId", "taskId"],
    path: (p, t) => `${taskPath(p, t)}/links`,
    fields: ["toTaskId", "type"],
    required: ["toTaskId", "type"],
  },
  "links.delete": {
    method: "DELETE",
    ids: ["projectId", "taskId", "targetId"],
    path: (p, t, l) => `${taskPath(p, t)}/links/${enc(l ?? "")}`,
    target: "linkId",
  },
  "time.start": {
    method: "POST",
    ids: ["projectId", "taskId"],
    path: (p, t) => `${taskPath(p, t)}/time-tracking/start`,
  },
  "time.stop": {
    method: "POST",
    ids: ["projectId", "taskId"],
    path: (p, t) => `${taskPath(p, t)}/time-tracking/stop`,
  },
  "tasks.approve": {
    method: "PATCH",
    ids: ["projectId", "taskId"],
    path: (p, t) => `${taskPath(p, t)}/approve`,
  },
  "tasks.archive": {
    method: "POST",
    ids: ["projectId", "taskId"],
    path: (p, t) => `${taskPath(p, t)}/archive`,
  },
  "tasks.restore": {
    method: "POST",
    ids: ["projectId", "taskId"],
    path: (p, t) => `${taskPath(p, t)}/restore`,
  },
};

/** Build a validated HTTP request from the single tool's input. */
export function buildRequest(input: ToolInput): RequestSpec {
  const spec = ACTIONS[input.action];
  if (!spec) {
    throw new Error(`Unknown action "${input.action}". Available: ${Object.keys(ACTIONS).join(", ")}`);
  }

  const ids: Record<string, string | undefined> = {
    projectId: input.projectId,
    taskId: input.taskId,
    targetId: input.targetId,
  };
  for (const id of spec.ids) {
    const value = ids[id];
    if (typeof value !== "string" || value.length === 0) {
      const label = id === "targetId" ? (spec.target ?? "targetId") : id;
      throw new Error(`Missing ${label} for ${input.action} — pass it as ${id}`);
    }
  }

  const params = input.params ?? {};
  for (const key of spec.required ?? []) {
    if (params[key] === undefined || params[key] === null || params[key] === "") {
      throw new Error(`Missing params.${key} for ${input.action}`);
    }
  }
  if (input.action === "links.add" && params.type !== "BLOCKS" && params.type !== "BLOCKED_BY") {
    throw new Error("params.type must be BLOCKS or BLOCKED_BY");
  }

  const path = spec.path(input.projectId, input.taskId, input.targetId);
  const result: RequestSpec = { method: spec.method, path };

  if (spec.method === "GET" && spec.fields) {
    const query = new URLSearchParams();
    for (const key of spec.fields) {
      const value = params[key];
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const encoded = query.toString();
    if (encoded) result.query = encoded;
  } else if (spec.fields) {
    const body: Record<string, unknown> = {};
    for (const key of spec.fields) {
      if (params[key] !== undefined) body[key] = params[key];
    }
    if (Object.keys(body).length > 0) result.body = body;
  }

  return result;
}

/** Turn an HTTP response into compact, model-friendly text. */
export function formatResponse(status: number, text: string, token: string): string {
  const clean = (token && text ? text.split(token).join("[redacted]") : text).trim();
  const hint = {
    401: "401 Unauthorized — проверьте токен (PROJEXIFY_TOKEN / token.txt).",
    403: "403 Forbidden — нет прав или токен не привязан к проекту.",
    404: "404 Not Found — проект или задача не найдены.",
    400: "400 Bad Request — неверный формат данных.",
    409: "409 Conflict — нарушение правил переходов статусов.",
  }[status];
  const out = hint
    ? `${hint} ${clean}`.trim()
    : status < 200 || status >= 300
      ? `${status} ${clean}`.trim()
      : clean || '{"ok":true}';
  if (out.length <= MAX_OUTPUT_CHARS) return out;
  return `${out.slice(0, MAX_OUTPUT_CHARS)}\n... truncated (${out.length - MAX_OUTPUT_CHARS} more chars)`;
}

export function resolveBaseURL(value?: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_BASE_URL;
  const url = raw.replace(/\/+$/, "");
  return url.endsWith(API_PATH) ? url : `${url}${API_PATH}`;
}

export function resolveToken(
  options: { token?: unknown } | undefined,
  env: Record<string, string | undefined>,
  fileToken: string,
): string {
  const fromOptions = typeof options?.token === "string" ? options.token.trim() : "";
  const fromEnv = typeof env.PROJEXIFY_TOKEN === "string" ? env.PROJEXIFY_TOKEN.trim() : "";
  return fromOptions || fromEnv || fileToken.trim() || "";
}

export const TOOL_DESCRIPTION = [
  "Call the projexify task tracker via one action. projectId is required for every action except projects.list;",
  "taskId for task actions; targetId carries userId/itemId/linkId. Query/write fields go in params.",
  "Actions:",
  "  projects.list | projects.get | projects.statuses | projects.members",
  "  tasks.list(params: q,statusId,assigneeId,priority,sortBy,sortOrder,limit,skip) | tasks.get | tasks.create(title,description,statusId,priority,dueDate,estimatedTime) | tasks.update | tasks.delete | tasks.setStatus(statusId)",
  "  tasks.assign(targetId=userId) | tasks.unassign(targetId=userId) | tasks.approve | tasks.archive | tasks.restore",
  "  comments.list | comments.add(content) | checklist.add(title) | checklist.update(targetId=itemId, params: title,checked) | checklist.delete(targetId=itemId)",
  "  links.add(params: toTaskId,type=BLOCKS|BLOCKED_BY) | links.delete(targetId=linkId) | time.start | time.stop",
  "Priorities: LOW|MEDIUM|HIGH|CRITICAL. Token is read from the plugin config, never pass it here.",
].join("\n");

export const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: Object.keys(ACTIONS), description: TOOL_DESCRIPTION },
    projectId: { type: "string", description: "Project ID; not needed for projects.list" },
    taskId: { type: "string", description: "Task ID; needed for all task actions" },
    targetId: { type: "string", description: "userId for assign/unassign, itemId for checklist, linkId for links.delete" },
    params: {
      type: "object",
      additionalProperties: true,
      description: "Query filters for tasks.list or JSON fields for write actions (see action docs)",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;
