/**
 * Публичные типы Agent Service API v1 (стабильный контракт).
 * Внутренние типы задач — в `runtime/task-registry.ts`.
 */
import type { ProblemDetails } from "./runtime/problem";
import type { TaskMode, TaskStatus, TaskUsage } from "./runtime/task-registry";

/** Статус сессии, выводимый из пула прогонов + меты. */
export type SessionStatus = "idle" | "working" | "queued" | "failed" | "archived";

/** Проекция сессии в API-ответ. */
export interface SessionSummary {
  id: string;
  externalRef?: string;
  name: string;
  status: SessionStatus;
  model: string;
  contextWindow: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Job-ресурс v1: единый объект для pull (`GET /v1/tasks/:jobId`) и push-колбэка. */
export interface JobObject {
  jobId: string;
  sessionId: string;
  status: TaskStatus;
  mode: TaskMode;
  progress?: { percent: number; message?: string };
  result?: { text: string; data?: unknown };
  usage?: TaskUsage;
  error?: ProblemDetails;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
