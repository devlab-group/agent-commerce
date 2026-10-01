import { describe, expect, it, vi } from 'vitest';
import { LOCAL_DEV_MERCHANT_ADDRESS } from '../../../src/cli/lib/init-config';

const { CANCEL } = vi.hoisted(() => ({ CANCEL: Symbol('cancel') }));

type Validate = (value: string | undefined) => string | undefined;

const state = vi.hoisted(() => ({
  backendBaseUrl: 'http://localhost:3000' as unknown,
  resources: ['weather', 'report'] as unknown,
  protocols: ['http', 'mcp'] as unknown,
  x402Enabled: true as unknown,
  merchantPayTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as unknown,
  // The real inline `validate` callback of each text prompt, keyed by field
  validators: {} as Record<'backendBaseUrl' | 'merchantPayTo', Validate | undefined>,
}));

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => value === CANCEL,
  text: vi.fn(async (opts: { message: string; validate?: Validate }) => {
    const field = opts.message.startsWith('Backend') ? 'backendBaseUrl' : 'merchantPayTo';
    state.validators[field] = opts.validate;
    return state[field];
  }),
  multiselect: vi.fn(async (opts: { message: string }) =>
    opts.message.includes('resource') ? state.resources : state.protocols,
  ),
  confirm: vi.fn(async () => state.x402Enabled),
}));

// Imported after the mock so `collectAnswersInteractive` picks it up
const { collectAnswersInteractive } = await import('../../../src/cli/commands/init');

describe('collectAnswersInteractive (real prompt flow, @clack/prompts mocked)', () => {
  it('collects a full set of answers on the happy path', async () => {
    state.backendBaseUrl = 'http://localhost:3000';
    state.resources = ['weather', 'report'];
    state.protocols = ['http', 'mcp'];
    state.x402Enabled = true;
    state.merchantPayTo = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

    const answers = await collectAnswersInteractive();

    // An empty protocol selection is refused at the prompt, not after it
    const clack = await import('@clack/prompts');
    expect(clack.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('protocols'), required: true }),
    );
    expect(answers).toEqual({
      backendBaseUrl: 'http://localhost:3000',
      resources: ['weather', 'report'],
      protocols: ['http', 'mcp'],
      x402Enabled: true,
      merchantPayTo: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    });
  });

  it('refuses an empty, relative or non-HTTP backend URL at the prompt', () => {
    const validate = state.validators.backendBaseUrl;
    expect(validate?.(undefined)).toBe('Required');
    expect(validate?.('  ')).toBe('Required');
    expect(validate?.('localhost-3000')).toBe(
      'Must be an absolute URL, e.g. http://localhost:3000',
    );
    expect(validate?.('ftp://example.com')).toBe('Must use http:// or https://');
    expect(validate?.(' https://api.example.com ')).toBeUndefined();
  });

  it('refuses a merchant address that is not a 20-byte hex address at the prompt', () => {
    const validate = state.validators.merchantPayTo;
    const shape = 'Must be a 0x-prefixed 20-byte EVM address (42 characters)';
    expect(validate?.('')).toBe('Required');
    expect(validate?.('0x1234')).toBe(shape);
    expect(validate?.(`0x${'g'.repeat(40)}`)).toBe(shape);
    expect(validate?.(`0x${'aB'.repeat(20)}`)).toBeUndefined();
  });

  it('skips the merchant-address prompt entirely when x402 is declined', async () => {
    const clack = await import('@clack/prompts');
    vi.mocked(clack.text).mockClear();
    state.x402Enabled = false;

    const answers = await collectAnswersInteractive();

    // Only the backend URL prompt ran
    expect(clack.text).toHaveBeenCalledTimes(1);
    expect(answers?.x402Enabled).toBe(false);
    expect(answers?.merchantPayTo).toBe(LOCAL_DEV_MERCHANT_ADDRESS);
  });

  it('returns undefined when the backend URL prompt is canceled', async () => {
    state.backendBaseUrl = CANCEL;
    const answers = await collectAnswersInteractive();
    expect(answers).toBeUndefined();
  });

  it('returns undefined when the resources prompt is canceled', async () => {
    state.backendBaseUrl = 'http://localhost:3000';
    state.resources = CANCEL;
    const answers = await collectAnswersInteractive();
    expect(answers).toBeUndefined();
  });

  it('returns undefined when the protocols prompt is canceled', async () => {
    state.resources = ['weather'];
    state.protocols = CANCEL;
    const answers = await collectAnswersInteractive();
    expect(answers).toBeUndefined();
  });

  it('returns undefined when the x402 confirm is canceled', async () => {
    state.protocols = ['http'];
    state.x402Enabled = CANCEL;
    const answers = await collectAnswersInteractive();
    expect(answers).toBeUndefined();
  });

  it('returns undefined when the merchant-address prompt is canceled', async () => {
    state.x402Enabled = true;
    state.merchantPayTo = CANCEL;
    const answers = await collectAnswersInteractive();
    expect(answers).toBeUndefined();
  });
});
