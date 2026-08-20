/**
 * CLI entry point for `npm run chain:start`.
 *
 * The actual implementation (spawn anvil, wait for the RPC, teardown) lives
 * in `src/payments/x402/local-chain/anvil.ts` — see that file's
 * header comment for why: `scripts/chain` has no `node_modules` of its own
 * (deliberately outside `src/`), so shared logic lives
 * inside a package that does, and this file is a thin CLI wrapper.
 */
import { startAnvil } from '../../src/payments/x402/local-chain/anvil.js';

const DEFAULT_PORT = 8545;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const detach = args.includes('--detach');
  const portArg = args.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) : DEFAULT_PORT;

  const handle = await startAnvil({ port, silent: detach });
  console.log(`anvil listening on ${handle.rpcUrl} (chain id ${handle.chainId})`);

  if (detach) {
    handle.process.unref();
    process.exit(0);
  }

  const shutdown = async (): Promise<void> => {
    await handle.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  await new Promise<void>((resolve) => {
    handle.process.once('exit', () => resolve());
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
