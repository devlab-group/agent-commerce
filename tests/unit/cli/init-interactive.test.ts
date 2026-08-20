import { describe, expect, it, vi } from 'vitest';

const { CANCEL } = vi.hoisted(() => ({ CANCEL: Symbol('cancel') }));

const state = vi.hoisted(() => ({
  backendBaseUrl: 'http://localhost:3000' as unknown,
  resources: ['weather', 'report'] as unknown,
  protocols: ['http', 'mcp'] as unknown,
  x402Enabled: true as unknown,
  merchantPayTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as unknown,
}));

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => value === CANCEL,
  text: vi.fn(
    async (opts: { message: string; validate?: (v: string | undefined) => string | undefined }) => {
      // Exercise the real inline `validate` callback's both branches (empty vs non-empty).
      opts.validate?.(undefined);
      opts.validate?.('non-empty');
      return opts.message.startsWith('Backend') ? state.backendBaseUrl : state.merchantPayTo;
    },
  ),
  multiselect: vi.fn(async (opts: { message: string }) =>
    opts.message.includes('resource') ? state.resources : state.protocols,
  ),
  confirm: vi.fn(async () => state.x402Enabled),
}));

// Imported after the mock so `collectAnswersInteractive` picks it up.
const { collectAnswersInteractive } = await import('../../../src/cli/commands/init.js');

describe('collectAnswersInteractive (real prompt flow, @clack/prompts mocked)', () => {
  it('collects a full set of answers on the happy path', async () => {
    state.backendBaseUrl = 'http://localhost:3000';
    state.resources = ['weather', 'report'];
    state.protocols = ['http', 'mcp'];
    state.x402Enabled = true;
    state.merchantPayTo = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

    const answers = await collectAnswersInteractive();

    expect(answers).toEqual({
      backendBaseUrl: 'http://localhost:3000',
      resources: ['weather', 'report'],
      protocols: ['http', 'mcp'],
      x402Enabled: true,
      merchantPayTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    });
  });

  it('skips the merchant-address prompt entirely when x402 is declined', async () => {
    state.x402Enabled = false;
    const answers = await collectAnswersInteractive();
    expect(answers?.x402Enabled).toBe(false);
    expect(answers?.merchantPayTo).toBeTruthy(); // falls back to the default
  });

  it('returns undefined when the backend URL prompt is cancelled', async () => {
    state.backendBaseUrl = CANCEL;
    const answers = await collectAnswersInteractive();
    expect(answers).toBeUndefined();
  });

  it('returns undefined when the resources prompt is cancelled', async () => {
    state.backendBaseUrl = 'http://localhost:3000';
    state.resources = CANCEL;
    const answers = await collectAnswersInteractive();
    expect(answers).toBeUndefined();
  });

  it('returns undefined when the protocols prompt is cancelled', async () => {
    state.resources = ['weather'];
    state.protocols = CANCEL;
    const answers = await collectAnswersInteractive();
    expect(answers).toBeUndefined();
  });

  it('returns undefined when the x402 confirm is cancelled', async () => {
    state.protocols = ['http'];
    state.x402Enabled = CANCEL;
    const answers = await collectAnswersInteractive();
    expect(answers).toBeUndefined();
  });

  it('returns undefined when the merchant-address prompt is cancelled', async () => {
    state.x402Enabled = true;
    state.merchantPayTo = CANCEL;
    const answers = await collectAnswersInteractive();
    expect(answers).toBeUndefined();
  });
});
