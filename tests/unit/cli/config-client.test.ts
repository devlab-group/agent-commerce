import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config/index.js', () => {
  throw new Error('simulated broken build');
});

describe('loadConfigDynamic — module load failure is caught and wrapped', () => {
  it('wraps a failed dynamic import in a catchable Error instead of crashing the caller', async () => {
    const { loadConfigDynamic } = await import('../../../src/cli/lib/config-client.js');
    await expect(loadConfigDynamic()).rejects.toThrow(/configuration module could not be loaded/);
  });
});
