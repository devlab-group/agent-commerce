/**
 * Composition root.
 *
 * The one place where concrete implementations meet. Everything else in this
 * package is pure dependency injection and is fully testable without this file
 * (see `createGateway`).
 *
 * Startup order is deliberate:
 * 1. load and validate configuration — an invalid config must stop the
 * process before anything binds a port or opens a socket;
 * 2. open the receipt store — the replay guard is a security control, so a
 * store that will not open is fatal, not degraded;
 * 3. build payment providers — a paid resource with no working provider must
 * fail closed at request time, not be quietly downgraded to free;
 * 4. build protocol adapters — these are isolated: one failing to start is
 * reported unhealthy and does not stop the others;
 * 5. listen, then print the effective settlement destination so an operator
 * or presenter can see where money actually goes.
 */
import { loadConfig } from '../config/index.js';
import type { PaymentProvider, ProtocolAdapter, ReceiptStore } from '../core/index.js';
import { CommerceError, isCommerceError } from '../core/index.js';
import { createX402PaymentProvider } from '../payments/x402/index.js';
import { createMcpAdapter } from '../protocols/mcp/index.js';
import { createSqliteReceiptStore } from '../storage/receipts/index.js';

import { createGatewayLogger } from './logger.js';
import { createGateway } from './server.js';

/** The host a presenter needs, without the credential a provider puts in the path. */
function rpcOrigin(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).origin;
  } catch {
    return '[unparseable rpcUrl]';
  }
}

async function main(): Promise<void> {
  const config = await loadConfig();

  const { core: logger } = createGatewayLogger({ name: config.merchant.id });

  const store: ReceiptStore = createSqliteReceiptStore({
    path: config.storage.receipts.path,
    logger,
  });
  await store.init();

  const paymentProviders: PaymentProvider[] = [];
  const x402 = config.payments.x402;
  if (x402?.enabled) {
    paymentProviders.push(
      createX402PaymentProvider({
        network: x402.network,
        rpcUrl: x402.rpcUrl,
        asset: x402.asset as `0x${string}`,
        assetName: x402.assetName,
        assetVersion: x402.assetVersion,
        assetDecimals: x402.assetDecimals,
        payTo: x402.payTo as `0x${string}`,
        maxTimeoutSeconds: x402.maxTimeoutSeconds,
        facilitator:
          x402.facilitator.mode === 'local'
            ? {
                mode: 'local',
                signerPrivateKey: x402.facilitator.signerPrivateKey as `0x${string}`,
              }
            : { mode: 'remote', url: x402.facilitator.url },
        logger,
      }),
    );
  }

  // A paid resource with no provider is a configuration error we can catch now
  // rather than discovering it on the first purchase attempt. Config validation
  // already rejects this, so reaching here means the two drifted apart.
  const paidWithoutProvider = config.resources.filter(
    (resource) =>
      resource.pricing.type !== 'free' &&
      !resource.paymentMethods.some((method) =>
        paymentProviders.some((provider) => provider.name === method),
      ),
  );
  if (paidWithoutProvider.length > 0) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Paid resources have no enabled payment provider: ${paidWithoutProvider
        .map((r) => r.id)
        .join(', ')}. Enable the rail in payments, or make the resource free.`,
    );
  }

  const protocolAdapters: ProtocolAdapter[] = [];
  if (config.protocols.mcp.enabled) {
    protocolAdapters.push(createMcpAdapter({ mountPath: config.protocols.mcp.mountPath }));
  }

  const gateway = await createGateway({
    config,
    store,
    paymentProviders,
    protocolAdapters,
    logger,
  });

  const { url } = await gateway.listen();

  logger.info(
    {
      url,
      merchant: config.merchant.id,
      resources: config.resources.length,
      protocols: protocolAdapters.map((adapter) => adapter.name),
      payments: paymentProviders.map((provider) => provider.name),
    },
    'gateway listening',
  );

  // Printed, not just logged: a presenter must be able to see the settlement
  // destination without reading JSON logs. Public values only — never the
  // facilitator signer.
  if (x402?.enabled) {
    console.log('');
    console.log('  x402 settlement');
    // Origin only, never the full URL. well-known.ts withholds rpcUrl entirely
    // because Alchemy, Infura and QuickNode all put the API key in the path —
    // and container stdout is routinely shipped to a log aggregator, where this
    // line has no redaction (REDACT_PATHS covers pino's structured fields, not
    // console.log). A presenter needs to see which network and which host, not
    // the credential.
    console.log(`    network      ${x402.network}  via ${rpcOrigin(x402.rpcUrl)}`);
    console.log(`    asset        ${x402.asset} (${x402.assetName} v${x402.assetVersion})`);
    console.log(`    pays to      ${x402.payTo}   <- merchant-controlled, not the gateway`);
    console.log(`    facilitator  ${x402.facilitator.mode}`);
    console.log('');
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    void (async () => {
      try {
        await gateway.close();
        await store.close();
        process.exit(0);
      } catch (error) {
        logger.error({ err: String(error) }, 'unclean shutdown');
        process.exit(1);
      }
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // Configuration and startup failures must be actionable, and must never
  // print a resolved secret. CommerceError details are already client-safe.
  if (isCommerceError(error)) {
    console.error(`\n  ${error.code}: ${error.message}\n`);
    if (error.details) console.error(`  ${JSON.stringify(error.details)}\n`);
  } else {
    console.error('\n  Gateway failed to start:', error instanceof Error ? error.message : error);
    console.error('');
  }
  process.exit(1);
});
