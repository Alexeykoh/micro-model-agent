// Лимитер запросов к LLM: защита от DoS — окно запросов в минуту + параллельные задачи.
interface RateLimitConfig {
  maxRequestsPerMinute: number;
  maxParallelTasks: number;
}

interface RateLimiterState {
  requests: number[]; // метки недавних запросов
  parallelTasks: number; // текущее число параллельных задач
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequestsPerMinute: 60,
  maxParallelTasks: 5,
};

/** Лимитер запросов к LLM (окно + параллелизм). */
export class RateLimiter {
  private config: RateLimitConfig;
  private state: RateLimiterState;
  private lastCleanup: number = 0;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      requests: [],
      parallelTasks: 0,
    };
  }

  /** Разрешён ли новый запрос (true) или сработал лимит (false). */
  canMakeRequest(): boolean {
    this.cleanupOldRequests();

    if (this.state.requests.length >= this.config.maxRequestsPerMinute) {
      return false;
    }

    return true;
  }

  /** Записать запрос в окно. */
  recordRequest(): void {
    this.cleanupOldRequests();
    this.state.requests.push(Date.now());
  }

  /** Можно ли стартовать параллельную задачу. */
  canStartParallelTask(): boolean {
    if (this.state.parallelTasks >= this.config.maxParallelTasks) {
      return false;
    }
    return true;
  }

  /** Старт параллельной задачи. */
  startParallelTask(): void {
    this.state.parallelTasks++;
  }

  /** Финиш параллельной задачи. */
  endParallelTask(): void {
    this.state.parallelTasks = Math.max(0, this.state.parallelTasks - 1);
  }

  /** Текущее число параллельных задач. */
  getParallelTaskCount(): number {
    return this.state.parallelTasks;
  }

  /** Остаток запросов в текущем окне. */
  getRemainingRequests(): number {
    this.cleanupOldRequests();
    return Math.max(0, this.config.maxRequestsPerMinute - this.state.requests.length);
  }

  /**
   * Миллисекунд до освобождения слота (старейший запрос вывалится из минутного
   * окна). 0 — запрос можно слать сразу.
   */
  msUntilRequest(): number {
    this.cleanupOldRequests();
    if (this.state.requests.length < this.config.maxRequestsPerMinute) return 0;
    const oldest = this.state.requests[0];
    return Math.max(0, 60_000 - (Date.now() - oldest));
  }

  /** Выкинуть запросы старше минуты. */
  private cleanupOldRequests(): void {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    // Чистка не чаще раза в 5 секунд — без оверхеда
    if (now - this.lastCleanup < 5000) {
      return;
    }

    this.state.requests = this.state.requests.filter((timestamp) => timestamp > oneMinuteAgo);
    this.lastCleanup = now;
  }

  /** Сбросить лимитер. */
  reset(): void {
    this.state.requests = [];
    this.state.parallelTasks = 0;
    this.lastCleanup = 0;
  }

  /** Текущий конфиг лимитов. */
  getConfig(): RateLimitConfig {
    return this.config;
  }

  /** Обновить конфиг лимитов. */
  updateConfig(config: Partial<RateLimitConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Глобальный лимитер для LLM-провайдера.
 */
export const globalRateLimiter = new RateLimiter();

/** Создать лимитер с кастомным конфигом. */
export function createRateLimiter(config?: Partial<RateLimitConfig>): RateLimiter {
  return new RateLimiter(config);
}
