import { describe, expect, it } from 'vitest';
import { createDemoLogger } from '../src/log.js';

describe('createDemoLogger', () => {
  it('prefixes each source distinctly', () => {
    const lines: string[] = [];
    const log = createDemoLogger((line) => lines.push(line));

    log.agent('a');
    log.gateway('g');
    log.buyer('b');
    log.receipt('r');

    expect(lines[0]).toContain('[agent]');
    expect(lines[0]).toContain('a');
    expect(lines[1]).toContain('[gateway]');
    expect(lines[2]).toContain('[buyer]');
    expect(lines[3]).toContain('[receipt]');
  });
});
