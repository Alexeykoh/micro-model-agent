import { describe, it, expect, beforeEach } from 'vitest';
import {
  SecurityPolicyManager,
  STRICT_POLICY,
  BALANCED_POLICY,
  PERMISSIVE_POLICY,
  SECURITY_POLICIES,
  globalSecurityPolicyManager,
  getSecurityPolicy,
  applySecurityPolicy,
  createSecurityPolicyManager,
  type SecurityPolicyPreset,
} from '../../src/modules/security/security-policies';
import type { SecurityConfig } from '../../src/config/types';
import { DEFAULT_SECURITY_CONFIG } from '../../src/config/security';

describe('SecurityPolicies', () => {
  describe('Policy definitions', () => {
    it('should have strict policy defined', () => {
      expect(STRICT_POLICY).toBeDefined();
      expect(STRICT_POLICY.name).toBe('Strict');
      expect(STRICT_POLICY.preset).toBe('strict');
      expect(STRICT_POLICY.description).toContain('Maximum security');
    });

    it('should have balanced policy defined', () => {
      expect(BALANCED_POLICY).toBeDefined();
      expect(BALANCED_POLICY.name).toBe('Balanced');
      expect(BALANCED_POLICY.preset).toBe('balanced');
      expect(BALANCED_POLICY.description).toContain('Good security');
    });

    it('should have permissive policy defined', () => {
      expect(PERMISSIVE_POLICY).toBeDefined();
      expect(PERMISSIVE_POLICY.name).toBe('Permissive');
      expect(PERMISSIVE_POLICY.preset).toBe('permissive');
      expect(PERMISSIVE_POLICY.description).toContain('Minimal security');
    });

    it('should have all policies in SECURITY_POLICIES', () => {
      expect(SECURITY_POLICIES.strict).toBe(STRICT_POLICY);
      expect(SECURITY_POLICIES.balanced).toBe(BALANCED_POLICY);
      expect(SECURITY_POLICIES.permissive).toBe(PERMISSIVE_POLICY);
      expect(SECURITY_POLICIES.custom).toBeDefined();
    });
  });

  describe('Policy configurations', () => {
    it('strict policy should have most restrictive bash blacklist', () => {
      expect(STRICT_POLICY.config.bash?.blacklist).toContain('rm');
      expect(STRICT_POLICY.config.bash?.blacklist).toContain('dd');
      expect(STRICT_POLICY.config.bash?.blacklist).toContain('chmod');
      expect(STRICT_POLICY.config.bash?.blacklist.length).toBeGreaterThan(
        BALANCED_POLICY.config.bash?.blacklist.length || 0
      );
    });

    it('strict policy should have most restrictive path denials', () => {
      expect(STRICT_POLICY.config.paths?.denied).toContain('.git/');
      expect(STRICT_POLICY.config.paths?.denied).toContain('node_modules/');
      expect(STRICT_POLICY.config.paths?.denied.length).toBeGreaterThan(
        BALANCED_POLICY.config.paths?.denied.length || 0
      );
    });

    it('strict policy should have lowest rate limits', () => {
      expect(STRICT_POLICY.config.rateLimits?.maxRequestsPerMinute).toBe(30);
      expect(STRICT_POLICY.config.rateLimits?.maxParallelTasks).toBe(3);
    });

    it('permissive policy should have highest rate limits', () => {
      expect(PERMISSIVE_POLICY.config.rateLimits?.maxRequestsPerMinute).toBe(120);
      expect(PERMISSIVE_POLICY.config.rateLimits?.maxParallelTasks).toBe(10);
    });

    it('strict policy should have session encryption enabled', () => {
      expect(STRICT_POLICY.config.sessionEncryption?.enabled).toBe(true);
    });

    it('permissive policy should have session encryption disabled', () => {
      expect(PERMISSIVE_POLICY.config.sessionEncryption?.enabled).toBe(false);
    });

    it('strict policy should have audit notifications enabled', () => {
      expect(STRICT_POLICY.config.auditNotifier?.enabled).toBe(true);
    });

    it('permissive policy should have audit notifications disabled', () => {
      expect(PERMISSIVE_POLICY.config.auditNotifier?.enabled).toBe(false);
    });
  });

  describe('SecurityPolicyManager', () => {
    let manager: SecurityPolicyManager;

    beforeEach(() => {
      manager = createSecurityPolicyManager();
    });

    it('should get all policies', () => {
      const policies = manager.getPolicies();
      expect(policies).toHaveLength(4); // strict, balanced, permissive, custom
      expect(policies.map(p => p.preset)).toContain('strict');
      expect(policies.map(p => p.preset)).toContain('balanced');
      expect(policies.map(p => p.preset)).toContain('permissive');
      expect(policies.map(p => p.preset)).toContain('custom');
    });

    it('should get a specific policy by name', () => {
      const strict = manager.getPolicy('strict');
      expect(strict).toBe(STRICT_POLICY);
      
      const balanced = manager.getPolicy('balanced');
      expect(balanced).toBe(BALANCED_POLICY);
      
      const permissive = manager.getPolicy('permissive');
      expect(permissive).toBe(PERMISSIVE_POLICY);
    });

    it('should return balanced policy for unknown preset', () => {
      const unknown = manager.getPolicy('unknown' as SecurityPolicyPreset);
      expect(unknown).toBe(BALANCED_POLICY);
    });

    it('should get current policy (default balanced)', () => {
      const current = manager.getCurrentPolicy();
      expect(current.preset).toBe('balanced');
    });

    it('should set and get current policy', () => {
      manager.setPolicy('strict');
      let current = manager.getCurrentPolicy();
      expect(current.preset).toBe('strict');
      
      manager.setPolicy('permissive');
      current = manager.getCurrentPolicy();
      expect(current.preset).toBe('permissive');
    });

    it('should set and get custom configuration', () => {
      const customConfig: Partial<SecurityConfig> = {
        maxRecursionDepth: 10,
        maxFileOperations: 500,
      };
      manager.setCustomConfig(customConfig);
      
      const current = manager.getCurrentPolicy();
      expect(current.preset).toBe('custom');
      expect(current.config.maxRecursionDepth).toBe(10);
      expect(current.config.maxFileOperations).toBe(500);
    });

    it('should get merged configuration', () => {
      manager.setPolicy('strict');
      const config = manager.getConfig();
      
      expect(config.bash.blacklist).toContain('rm');
      expect(config.paths.denied).toContain('.git/');
      expect(config.maxRecursionDepth).toBe(2);
      expect(config.rateLimits.maxRequestsPerMinute).toBe(30);
    });

    it('should apply policy and return merged configuration', () => {
      const config = manager.applyPolicy('strict');
      
      expect(config.bash.blacklist).toContain('rm');
      expect(config.maxRecursionDepth).toBe(2);
    });

    it('should apply policy with custom overrides', () => {
      const config = manager.applyPolicy('balanced', {
        maxRecursionDepth: 10,
      });
      
      expect(config.maxRecursionDepth).toBe(10);
      // Other balanced settings should still be there
      expect(config.rateLimits.maxRequestsPerMinute).toBe(60);
    });

    it('should get policy recommendation for use case', () => {
      const productionRec = manager.getRecommendation('production');
      expect(productionRec.preset).toBe('strict');
      
      const developmentRec = manager.getRecommendation('development');
      expect(developmentRec.preset).toBe('balanced');
      
      const testingRec = manager.getRecommendation('sandbox');
      expect(testingRec.preset).toBe('permissive');
      
      const unknownRec = manager.getRecommendation('unknown');
      expect(unknownRec.preset).toBe('balanced');
    });

    it('should check if action is allowed', () => {
      manager.setPolicy('strict');
      
      // Bash commands
      expect(manager.allowsAction('bash', { type: 'command', command: 'ls' })).toBe(true);
      expect(manager.allowsAction('bash', { type: 'command', command: 'rm file.txt' })).toBe(false);
      
      // File access
      expect(manager.allowsAction('file_access', { type: 'file', path: 'src/index.ts' })).toBe(true);
      expect(manager.allowsAction('file_access', { type: 'file', path: '.git/config' })).toBe(false);
      
      // Network
      expect(manager.allowsAction('network', { type: 'network', path: 'https://example.com' })).toBe(true);
      expect(manager.allowsAction('network', { type: 'network', path: 'localhost' })).toBe(false);
    });

    it('should compare policies', () => {
      const comparison = manager.comparePolicies('strict', 'permissive');
      
      expect(comparison.bash).toBeDefined();
      expect(comparison.paths).toBeDefined();
      expect(comparison.rateLimits).toBeDefined();
      
      // Strict should have lower rate limits
      expect((comparison.rateLimits as any).policy1.maxRequestsPerMinute).toBeLessThan(
        (comparison.rateLimits as any).policy2.maxRequestsPerMinute
      );
    });
  });

  describe('Global functions', () => {
    it('should get policy by name', () => {
      const strict = getSecurityPolicy('strict');
      expect(strict).toBe(STRICT_POLICY);
    });

    it('should apply security policy', () => {
      const config = applySecurityPolicy('strict');
      expect(config.bash.blacklist).toContain('rm');
    });

    it('should apply security policy with custom overrides', () => {
      const config = applySecurityPolicy('balanced', {
        maxRecursionDepth: 100,
      });
      expect(config.maxRecursionDepth).toBe(100);
    });
  });

  describe('Global instance', () => {
    it('should have a global instance', () => {
      expect(globalSecurityPolicyManager).toBeInstanceOf(SecurityPolicyManager);
    });

    it('should get current policy from global instance', () => {
      const policy = globalSecurityPolicyManager.getCurrentPolicy();
      // Default is balanced, but global instance might have been modified
      expect(['balanced', 'custom']).toContain(policy.preset);
    });

    it('should get config from global instance', () => {
      const config = globalSecurityPolicyManager.getConfig();
      expect(config).toHaveProperty('bash');
      expect(config).toHaveProperty('paths');
      expect(config).toHaveProperty('network');
    });
  });

  describe('Policy merging', () => {
    let manager: SecurityPolicyManager;
    
    beforeEach(() => {
      manager = createSecurityPolicyManager();
    });

    it('should merge policy config with defaults', () => {
      manager.setPolicy('strict');
      const config = manager.getConfig();
      
      // Should have all default properties
      expect(config).toHaveProperty('bash');
      expect(config).toHaveProperty('paths');
      expect(config).toHaveProperty('network');
      expect(config).toHaveProperty('maxRecursionDepth');
      expect(config).toHaveProperty('maxFileOperations');
      expect(config).toHaveProperty('rateLimits');
      expect(config).toHaveProperty('contentScan');
      
      // Should have strict-specific values
      expect(config.maxRecursionDepth).toBe(2);
      expect(config.rateLimits.maxRequestsPerMinute).toBe(30);
    });

    it('should override defaults with policy values', () => {
      manager.setPolicy('permissive');
      const config = manager.getConfig();
      
      expect(config.maxRecursionDepth).toBe(5);
      expect(config.rateLimits.maxRequestsPerMinute).toBe(120);
    });
  });

  describe('Recommended use cases', () => {
    it('strict policy should be recommended for production', () => {
      expect(STRICT_POLICY.recommendedFor).toContain('production');
      expect(STRICT_POLICY.recommendedFor).toContain('sensitive-data');
    });

    it('balanced policy should be recommended for development', () => {
      expect(BALANCED_POLICY.recommendedFor).toContain('development');
      expect(BALANCED_POLICY.recommendedFor).toContain('general-use');
    });

    it('permissive policy should be recommended for testing', () => {
      expect(PERMISSIVE_POLICY.recommendedFor).toContain('testing');
      expect(PERMISSIVE_POLICY.recommendedFor).toContain('sandbox');
    });
  });
});
