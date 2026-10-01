import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config', () => {
  throw new Error('simulated broken build');
});

describe('config-client: a module load failure is caught and wrapped', () => {
  it('wraps a failed dynamic import in a catchable Error instead of crashing the caller', async () => {
    const { loadConfigDynamic, parseConfigDynamic } = await import(
      '../../../src/cli/lib/config-client'
    );
    await expect(loadConfigDynamic()).rejects.toThrow(/configuration module could not be loaded/);
    await expect(parseConfigDynamic({})).rejects.toThrow(
      /configuration module could not be loaded/,
    );
  });
});
