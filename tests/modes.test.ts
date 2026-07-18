import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/agent/system-prompt.js';
import type { Skill } from '../src/skills/loader.js';

const testSkill: Skill = {
  name: 'test-skill',
  path: '/dev/null',
  content: '# Test Skill\nSome instructions',
  tokens: 10,
};

describe('Agent modes — позитивные сценарии', () => {

  it('base mode включает блок Available Skills', () => {
    const prompt = buildSystemPrompt(undefined, 'base');
    expect(prompt).toContain('Available Skills');
    expect(prompt).toContain('@skill-name');
  });

  it('base mode не содержит секций Mode: Fast или Mode: Pro', () => {
    const prompt = buildSystemPrompt(undefined, 'base');
    expect(prompt).not.toContain('Mode: Fast');
    expect(prompt).not.toContain('Mode: Pro');
  });

  it('fast mode содержит Mode: Fast', () => {
    const prompt = buildSystemPrompt(undefined, 'fast');
    expect(prompt).toContain('Mode: Fast');
  });

  it('fast mode не содержит Available Skills', () => {
    const prompt = buildSystemPrompt(undefined, 'fast');
    expect(prompt).not.toContain('Available Skills');
  });

  it('fast mode не содержит @skill-name', () => {
    const prompt = buildSystemPrompt(undefined, 'fast');
    expect(prompt).not.toContain('@skill-name');
  });

  it('fast mode не показывает загруженные скилы', () => {
    const prompt = buildSystemPrompt([testSkill], 'fast');
    expect(prompt).not.toContain('test-skill');
    expect(prompt).not.toContain('Loaded Skills');
  });

  it('pro mode содержит Mode: Pro и grill-me', () => {
    const prompt = buildSystemPrompt(undefined, 'pro');
    expect(prompt).toContain('Mode: Pro');
    expect(prompt).toContain('grill-me');
  });

  it('pro mode содержит упоминание 64000 контекста', () => {
    const prompt = buildSystemPrompt(undefined, 'pro');
    expect(prompt).toContain('64000');
  });

  it('pro mode сохраняет блок Available Skills', () => {
    const prompt = buildSystemPrompt(undefined, 'pro');
    expect(prompt).toContain('Available Skills');
  });

  it('pro mode с extraSkills показывает и grill-me и загруженные скилы', () => {
    const prompt = buildSystemPrompt([testSkill], 'pro');
    expect(prompt).toContain('Mode: Pro');
    expect(prompt).toContain('grill-me');
    expect(prompt).toContain('test-skill');
  });

  it('undefined mode ведёт себя как base (есть Available Skills)', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Available Skills');
    expect(prompt).not.toContain('Mode: Fast');
    expect(prompt).not.toContain('Mode: Pro');
  });
});

describe('Agent modes — негативные сценарии', () => {

  it('fast mode НЕ должен содержать Mode: Pro', () => {
    const prompt = buildSystemPrompt(undefined, 'fast');
    expect(prompt).not.toContain('Mode: Pro');
  });

  it('fast mode НЕ должен содержать блок Available Skills', () => {
    const prompt = buildSystemPrompt(undefined, 'fast');
    expect(prompt).not.toContain('Available Skills');
    expect(prompt).not.toContain('Installed skills:');
  });

  it('fast mode даже с extraSkills НЕ выводит секцию Loaded Skills', () => {
    const prompt = buildSystemPrompt([testSkill], 'fast');
    expect(prompt).not.toContain('## Loaded Skills');
  });

  it('fast mode НЕ должен упоминать @skill-name (из skillsHint)', () => {
    const prompt = buildSystemPrompt(undefined, 'fast');
    expect(prompt).not.toContain('@skill-name');
  });

  it('fast mode НЕ должен содержать рекомендации загружать скилы', () => {
    const prompt = buildSystemPrompt(undefined, 'fast');
    expect(prompt).not.toContain('Рекомендую @');
    expect(prompt).not.toContain('If skills are NOT loaded');
  });

  it('pro mode НЕ должен содержать Mode: Fast', () => {
    const prompt = buildSystemPrompt(undefined, 'pro');
    expect(prompt).not.toContain('Mode: Fast');
  });

  it('pro mode НЕ должен блокировать Available Skills (как fast)', () => {
    const prompt = buildSystemPrompt(undefined, 'pro');
    expect(prompt).toContain('Available Skills');
    expect(prompt).not.toContain('Fast mode');
  });

  it('base mode НЕ должен содержать секцию Mode: Pro', () => {
    const prompt = buildSystemPrompt(undefined, 'base');
    expect(prompt).not.toContain('Mode: Pro');
  });

  it('base mode НЕ должен содержать упоминание 64000', () => {
    const prompt = buildSystemPrompt(undefined, 'base');
    expect(prompt).not.toContain('64000');
  });

  it('base mode с extraSkills показывает Loaded Skills', () => {
    const prompt = buildSystemPrompt([testSkill], 'base');
    expect(prompt).toContain('test-skill');
    expect(prompt).toContain('Loaded Skills');
  });
});
