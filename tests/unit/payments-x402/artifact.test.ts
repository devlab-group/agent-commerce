// The MockUSDC artifact as the Docker chain-deploy step sees it: no forge
// build output, no Foundry on PATH, only the committed copy
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMockUsdcArtifact } from '../../../src/payments/x402/local-chain/artifact';

const hidden = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: string) =>
      !hidden.paths.some((part) => String(path).includes(part)) && actual.existsSync(path),
  };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: () => {
    throw Object.assign(new Error('spawn forge ENOENT'), { code: 'ENOENT' });
  },
}));

const FORGE_OUT = `${sep}${join('contracts', 'out')}${sep}`;
const COMMITTED = join('contracts', 'artifacts', 'MockUSDC.json');

beforeEach(() => {
  hidden.paths = [];
});

describe('loadMockUsdcArtifact without Foundry', () => {
  it('deploys the committed artifact when there is no forge build output', () => {
    hidden.paths = [FORGE_OUT];
    const committed = JSON.parse(readFileSync(COMMITTED, 'utf8')) as { bytecode: string };

    expect(loadMockUsdcArtifact().bytecode).toBe(committed.bytecode);
  });

  it('says how to produce an artifact when there is none', () => {
    hidden.paths = [FORGE_OUT, COMMITTED];

    expect(() => loadMockUsdcArtifact()).toThrow(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining('scripts/chain/build-artifact.ts'),
      }),
    );
  });
});
