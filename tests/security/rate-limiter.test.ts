import { RateLimiter, createRateLimiter, globalRateLimiter } from '../../src/modules/security/rate-limiter';
import { describe, it, expect, beforeEach } from 'vitest';

describe('Rate Limiter', () => {
  describe('RateLimiter class', () => {
    let limiter: RateLimiter;

    beforeEach(() => {
      limiter = new RateLimiter({
        maxRequestsPerMinute: 10,
        maxParallelTasks: 3,
      });
    });

    it('should allow requests under the limit', () => {
      for (let i = 0; i < 10; i++) {
        expect(limiter.canMakeRequest()).toBe(true);
        limiter.recordRequest();
      }
    });

    it('should block requests over the limit', () => {
      for (let i = 0; i < 10; i++) {
        limiter.recordRequest();
      }
      expect(limiter.canMakeRequest()).toBe(false);
    });

    it('should allow parallel tasks under the limit', () => {
      for (let i = 0; i < 3; i++) {
        expect(limiter.canStartParallelTask()).toBe(true);
        limiter.startParallelTask();
      }
    });

    it('should block parallel tasks over the limit', () => {
      for (let i = 0; i < 3; i++) {
        limiter.startParallelTask();
      }
      expect(limiter.canStartParallelTask()).toBe(false);
    });

    it('should track parallel task count', () => {
      expect(limiter.getParallelTaskCount()).toBe(0);
      limiter.startParallelTask();
      expect(limiter.getParallelTaskCount()).toBe(1);
      limiter.startParallelTask();
      expect(limiter.getParallelTaskCount()).toBe(2);
      limiter.endParallelTask();
      expect(limiter.getParallelTaskCount()).toBe(1);
    });

    it('should not allow negative parallel task count', () => {
      limiter.endParallelTask();
      limiter.endParallelTask();
      expect(limiter.getParallelTaskCount()).toBe(0);
    });

    it('should return remaining requests', () => {
      expect(limiter.getRemainingRequests()).toBe(10);
      limiter.recordRequest();
      expect(limiter.getRemainingRequests()).toBe(9);
    });

    it('should reset properly', () => {
      limiter.recordRequest();
      limiter.startParallelTask();
      limiter.reset();
      expect(limiter.getRemainingRequests()).toBe(10);
      expect(limiter.getParallelTaskCount()).toBe(0);
    });

    it('should update configuration', () => {
      limiter.updateConfig({ maxRequestsPerMinute: 20 });
      expect(limiter.getConfig().maxRequestsPerMinute).toBe(20);
    });

    it('should use default configuration when none provided', () => {
      const defaultLimiter = new RateLimiter();
      expect(defaultLimiter.getConfig().maxRequestsPerMinute).toBe(60);
      expect(defaultLimiter.getConfig().maxParallelTasks).toBe(5);
    });
  });

  describe('createRateLimiter', () => {
    it('should create a rate limiter with custom config', () => {
      const limiter = createRateLimiter({ maxRequestsPerMinute: 5 });
      expect(limiter.getConfig().maxRequestsPerMinute).toBe(5);
    });
  });

  describe('globalRateLimiter', () => {
    it('should be a RateLimiter instance', () => {
      expect(globalRateLimiter).toBeInstanceOf(RateLimiter);
    });

    it('should have default configuration', () => {
      expect(globalRateLimiter.getConfig().maxRequestsPerMinute).toBe(60);
      expect(globalRateLimiter.getConfig().maxParallelTasks).toBe(5);
    });
  });
});
