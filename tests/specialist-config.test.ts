import { describe, it, expect } from 'vitest';
import { getSpecialistConfig, getLLMConfig } from '../src/config/config.js';
import type { AppConfig } from '../src/config/types.js';

describe('getSpecialistConfig', () => {

  it('returns defaults when no config provided', () => {
    const result = getSpecialistConfig();
    expect(result.enabled).toBe(true);
    expect(result.triggerThreshold).toBe(2);
    expect(result.maxSteps).toBe(10);
    expect(result.minErrorLength).toBe(15);
  });

  it('returns defaults for empty config', () => {
    const config = {} as AppConfig;
    const result = getSpecialistConfig(config);
    expect(result.enabled).toBe(true);
    expect(result.triggerThreshold).toBe(2);
  });

  it('overrides with user config', () => {
    const config = {
      agent: {
        specialist: {
          enabled: false,
          triggerThreshold: 3,
          maxSteps: 5,
          minErrorLength: 20,
        },
      },
    } as AppConfig;
    const result = getSpecialistConfig(config);
    expect(result.enabled).toBe(false);
    expect(result.triggerThreshold).toBe(3);
    expect(result.maxSteps).toBe(5);
    expect(result.minErrorLength).toBe(20);
  });

  it('partial override fills missing fields with defaults', () => {
    const config = {
      agent: {
        specialist: {
          enabled: false,
        },
      },
    } as AppConfig;
    const result = getSpecialistConfig(config);
    expect(result.enabled).toBe(false);
    expect(result.triggerThreshold).toBe(2); // default
    expect(result.maxSteps).toBe(10); // default
    expect(result.minErrorLength).toBe(15); // default
  });
});

describe('getLLMConfig specialist-related', () => {

  it('returns toolModel as undefined by default', () => {
    const result = getLLMConfig();
    expect(result.toolModel).toBeUndefined();
  });

  it('returns toolModel when configured', () => {
    const config = {
      agent: {
        llm: {
          toolModel: 'qwen/qwen3.5-9b',
        },
      },
    } as AppConfig;
    const result = getLLMConfig(config);
    expect(result.toolModel).toBe('qwen/qwen3.5-9b');
  });
});
