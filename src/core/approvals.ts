/**
 * Одноразовые разрешения пользователя на запись в защищённый путь.
 *
 * Закрывает долг `approve-marker-not-authoritative`: раньше подтверждение жило
 * только строкой в ответе модели, и `[APPROVED]` ничего не авторизовал (а текст
 * модели вообще недоверенный). Теперь решение — состояние: его кладёт только
 * хендлер `approve` после ответа пользователя, а читает только enforcement
 * (`checkToolPath`), по одному разу на вызов тула.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { APPROVAL_TTL_MS } from "../config/timeouts";

/** Выданное разрешение: путь, текст действия и срок жизни. */
export interface ApprovalGrant {
  /** Случайный id (randomUUID) — только для аудита, модели не нужен. */
  token: string;
  /** Нормализованный абсолютный путь, на который выдано разрешение. */
  path: string;
  /** Текст действия, который видел пользователь. */
  action: string;
  /** Момент истечения (ms epoch). */
  expiresAt: number;
  /** `toolCallId`, который уже потребовал разрешение (TOCTOU-recheck). */
  usedBy?: string;
}

/** Зависимости хранилища (всё инжектируется для тестов). */
export interface ApprovalStoreDeps {
  ttlMs?: number;
  now?: () => number;
  newToken?: () => string;
}

/**
 * Нормализация пути для сравнения: абсолютный, без `..`, регистр — как у ФС.
 * Тот же путь, что увидит enforcement (`safeResolvePath`), поэтому нормализуем
 * ещё раз здесь, чтобы хранилище не зависело от вызывающего.
 */
function normalize(path: string): string {
  const abs = resolve(path);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

/** Хранилище разрешений: per-process, живёт столько же, сколько `ToolContext`. */
export class ApprovalStore {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly newToken: () => string;
  private grants: ApprovalGrant[] = [];

  constructor(deps: ApprovalStoreDeps = {}) {
    this.ttlMs = deps.ttlMs ?? APPROVAL_TTL_MS;
    this.now = deps.now ?? Date.now;
    this.newToken = deps.newToken ?? randomUUID;
  }

  /** Выдать одноразовое разрешение на `path` (вызывает только `approve`). */
  grant(path: string, action: string): ApprovalGrant {
    const grant: ApprovalGrant = {
      token: this.newToken(),
      path: normalize(path),
      action,
      expiresAt: this.now() + this.ttlMs,
    };
    this.grants.push(grant);
    return { ...grant };
  }

  /**
   * Потребить разрешение для `path` от имени `callId`.
   *
   * Повторный вызов с тем же `callId` возвращает то же разрешение: enforcement
   * проверяет путь дважды (до хендлера и TOCTOU-хуком), и второй recheck не
   * должен блокировать уже разрешённую операцию. Другой `callId` разрешение не
   * получает — оно одноразовое.
   */
  consume(path: string, callId: string): ApprovalGrant | undefined {
    this.purgeExpired();
    const key = normalize(path);
    const grant = this.grants.find(
      (g) => g.path === key && (g.usedBy === undefined || g.usedBy === callId),
    );
    if (!grant) return undefined;
    grant.usedBy ??= callId;
    return { ...grant };
  }

  /** Сколько разрешений в хранилище (включая уже потреблённые, но не истёкшие). */
  size(): number {
    this.purgeExpired();
    return this.grants.length;
  }

  /** Сбросить всё (конец сессии). */
  clear(): void {
    this.grants = [];
  }

  private purgeExpired(): void {
    const now = this.now();
    this.grants = this.grants.filter((g) => g.expiresAt > now);
  }
}

