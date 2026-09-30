import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('vite config', () => {
  // Guards the anchored root (see vite.config.ts)
  it('roots the dev server at the directory holding index.html', () => {
    const root = (config as { root?: string }).root;
    expect(root).toBeDefined();
    expect(existsSync(join(root as string, 'index.html'))).toBe(true);
  });
});
