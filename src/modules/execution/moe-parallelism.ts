/**
 * Параллелизм подзадач MoE против возможностей бэкенда.
 *
 * Наблюдалось (живая сессия `ses_muz7sg1l_0ankgu`, LM Studio): две независимые
 * подзадачи одной волны стартовали одновременно, и локальный однодвижковый
 * бэкенд отдал `Engine protocol startup was aborted` — параллельные запросы к
 * одной модели дерутся за load/unload движка. Для hosted-провайдера параллелизм
 * безопасен и нужен, поэтому решение принимается по типу и адресу бэкенда.
 */
import type { AppConfig } from "../../config/types";
import { activeProviderEndpoint } from "../providers/manager";

/** Кап конкурентных подзадач, когда бэкенд это переживает. */
export const DEFAULT_PARALLEL_SUBTASKS = 5;

/** Локальный однодвижковый бэкенд: параллелизм сводится к 1. */
export const LOCAL_PARALLEL_SUBTASKS = 1;

/** Типы провайдеров, которые обслуживает один локальный движок. */
const LOCAL_SINGLE_ENGINE_TYPES = new Set(["lmstudio", "ollama"]);

/** Хосты, за которыми почти всегда один локальный процесс с моделью. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/**
 * Истинно, если активный бэкенд — локальный процесс с одной моделью
 * (LM Studio, Ollama, llama.cpp на loopback).
 * @param config живой конфиг (только читается).
 */
export function isLocalSingleEngine(config: AppConfig): boolean {
  let type = config.provider?.type ?? "";
  let baseUrl = config.provider?.baseUrl ?? "";
  try {
    const active = activeProviderEndpoint(config.provider);
    type = active.type ?? type;
    baseUrl = active.baseUrl ?? baseUrl;
  } catch {
    // Активная запись не резолвится — берём легаси-поля как есть.
  }
  if (LOCAL_SINGLE_ENGINE_TYPES.has(type)) return true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return LOCAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

/**
 * Сколько подзадач волны можно исполнять одновременно.
 *
 * Явный `moe.parallelSubtasks` всегда выигрывает (пользователь может знать
 * лучше). Иначе локальный однодвижковый бэкенд → 1, остальные — кап из
 * `security.rateLimits.maxParallelTasks` (по умолчанию 5).
 * @param config живой конфиг.
 * @returns положительный кап параллелизма.
 */
export function resolveParallelSubtasks(config: AppConfig): number {
  const explicit = config.moe?.parallelSubtasks;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  if (isLocalSingleEngine(config)) return LOCAL_PARALLEL_SUBTASKS;
  const cap = config.security?.rateLimits?.maxParallelTasks ?? DEFAULT_PARALLEL_SUBTASKS;
  return Math.max(1, cap);
}
