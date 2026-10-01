import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('vite config', () => {
  // Guards the anchored root (see vite.config.ts)
  it('roots the dev server at the dashboard directory', () => {
    const dashboardDir = fileURLToPath(new URL('..', import.meta.url));
    const root = (config as { root?: string }).root;
    expect(resolve(root ?? '')).toBe(resolve(dashboardDir));
  });
});
