/**
 * Rate limiter for LLM requests
 * Prevents DoS attacks by limiting the number of requests per time window
 */

interface RateLimitConfig {
  maxRequestsPerMinute: number;
  maxParallelTasks: number;
}

interface RateLimiterState {
  requests: number[]; // Timestamps of recent requests
  parallelTasks: number; // Current number of parallel tasks
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequestsPerMinute: 60,
  maxParallelTasks: 5,
};

/**
 * Rate limiter class for tracking LLM requests
 */
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

  /**
   * Check if a new request is allowed
   * Returns true if the request is allowed, false if rate limited
   */
  canMakeRequest(): boolean {
    this.cleanupOldRequests();
    
    if (this.state.requests.length >= this.config.maxRequestsPerMinute) {
      return false;
    }
    
    return true;
  }

  /**
   * Record a request
   */
  recordRequest(): void {
    this.cleanupOldRequests();
    this.state.requests.push(Date.now());
  }

  /**
   * Check if a new parallel task is allowed
   */
  canStartParallelTask(): boolean {
    if (this.state.parallelTasks >= this.config.maxParallelTasks) {
      return false;
    }
    return true;
  }

  /**
   * Start a parallel task
   */
  startParallelTask(): void {
    this.state.parallelTasks++;
  }

  /**
   * End a parallel task
   */
  endParallelTask(): void {
    this.state.parallelTasks = Math.max(0, this.state.parallelTasks - 1);
  }

  /**
   * Get current parallel task count
   */
  getParallelTaskCount(): number {
    return this.state.parallelTasks;
  }

  /**
   * Get remaining requests in current window
   */
  getRemainingRequests(): number {
    this.cleanupOldRequests();
    return Math.max(0, this.config.maxRequestsPerMinute - this.state.requests.length);
  }

  /**
   * Clean up old requests (older than 1 minute)
   */
  private cleanupOldRequests(): void {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    
    // Only cleanup every 5 seconds to avoid performance overhead
    if (now - this.lastCleanup < 5000) {
      return;
    }
    
    this.state.requests = this.state.requests.filter(
      (timestamp) => timestamp > oneMinuteAgo,
    );
    this.lastCleanup = now;
  }

  /**
   * Reset the rate limiter
   */
  reset(): void {
    this.state.requests = [];
    this.state.parallelTasks = 0;
    this.lastCleanup = 0;
  }

  /**
   * Get rate limit configuration
   */
  getConfig(): RateLimitConfig {
    return this.config;
  }

  /**
   * Update rate limit configuration
   */
  updateConfig(config: Partial<RateLimitConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Global rate limiter instance
 * Can be used by LLM provider to enforce rate limits
 */
export const globalRateLimiter = new RateLimiter();

/**
 * Create a rate limiter with custom configuration
 */
export function createRateLimiter(config?: Partial<RateLimitConfig>): RateLimiter {
  return new RateLimiter(config);
}
