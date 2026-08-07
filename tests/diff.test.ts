import { describe, it, expect } from 'vitest'
import {
  generateDiff,
  generateNewFileDiff,
  generateDeleteDiff,
} from '../src/ui/diff'

describe('diff rendering (no background color)', () => {
  it('generateDiff remove lines keep plain text, colored only the minus marker', () => {
    const out = generateDiff('a\nb\nc', 'a\nx\nc')
    // No background ANSI codes.
    expect(out).not.toContain('\x1b[41m')
    expect(out).not.toContain('\x1b[42m')
    // The removed line is plain text with a " - " marker.
    expect(out).toContain('- b')
    // The added line is plain text with a " + " marker.
    expect(out).toContain('+ x')
  })

  it('generateDiff returns empty for identical content', () => {
    expect(generateDiff('same', 'same')).toBe('')
  })

  it('generateNewFileDiff marks every line as added, no background', () => {
    const out = generateNewFileDiff('l1\nl2')
    expect(out).not.toContain('\x1b[42m')
    expect(out).toContain('+ l1')
    expect(out).toContain('+ l2')
  })

  it('generateDeleteDiff marks every line as removed, no background', () => {
    const out = generateDeleteDiff('l1\nl2')
    expect(out).not.toContain('\x1b[41m')
    expect(out).toContain('- l1')
    expect(out).toContain('- l2')
  })

  it('generateDiff context lines stay plain', () => {
    const out = generateDiff('a\nb\nc', 'a\nx\nc')
    expect(out).toContain('a')
    expect(out).toContain('c')
  })
})
