import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../vite.config.js';

describe('vite config', () => {
  // The dev server is launched from the repository root, so an unset `root`
  // resolves to the repo root and every request answers 404 with no
  // explanation. Cheap to assert here; expensive to notice in a browser.
  it('roots the dev server at the directory holding index.html', () => {
    const root = (config as { root?: string }).root;
    expect(root).toBeDefined();
    expect(existsSync(join(root as string, 'index.html'))).toBe(true);
  });
});
