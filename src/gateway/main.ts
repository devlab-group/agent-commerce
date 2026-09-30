/**
 * Composition root: the one place concrete implementations meet. Everything
 * else is dependency-injected and testable without this file (see
 * `createGateway`).
 *
 * Startup order:
 * 1. load and validate configuration, so an invalid config stops the process
 * before anything binds a port or opens a socket;
 * 2. open the receipt store: the replay guard is a security control, so a
 * store that will not open is fatal, not degraded;
 * 3. build payment providers: a paid resource with no enabled provider stops
 * startup, and a provider that fails at request time fails the request closed
 * instead of serving it free;
 * 3b. build authorization providers: the AP2 replay database opens here, so a
 * mandate store that will not open stops startup;
 * 4. build protocol adapters, isolated so one that fails to start is reported
 * unhealthy and does not stop the others;
 * 5. listen, then print the settlement destination so an operator can see
 * where the money goes.
 */
import type { Ap2AuthorizationProvider } from '../authorization/ap2';
import { createAp2AuthorizationProvider } from '../authorization/ap2';
import { loadConfig } from '../config';
import type { ProtocolAdapter, ReceiptStore } from '../core';
import { CommerceError, isCommerceError } from '../core';
import { createA2aAdapter } from '../protocols/a2a';
import { createAcpAdapter } from '../protocols/acp';
import { createMcpAdapter } from '../protocols/mcp';
import { createSqliteReceiptStore } from '../storage/receipts';

import { createGatewayLogger } from './logger';
import { createConfiguredPaymentProviders } from './payment-providers';
import { createGateway } from './server';

// The host a presenter needs, without the credential a provider puts in the path
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

  const paymentProviders = createConfiguredPaymentProviders(config.payments, logger);

  // Built only when enabled: the constructor opens the replay database, so a
  // disabled AP2 block creates no file and holds no handle
  const authorizationProviders: Ap2AuthorizationProvider[] = [];
  const ap2 = config.authorization?.ap2;
  if (ap2?.enabled) {
    authorizationProviders.push(createAp2AuthorizationProvider({ config: ap2, logger }));
  }

  // Config validation already rejects a paid resource with no enabled rail;
  // this catches the two drifting apart before the first purchase attempt
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
  if (config.protocols.a2a.enabled) {
    protocolAdapters.push(
      createA2aAdapter({
        mountPath: config.protocols.a2a.mountPath,
        // The Agent Card names the merchant, not the software: a client
        // picking between agents is choosing whose resources to buy
        agentName: config.merchant.name,
      }),
    );
  }

  const acp = config.protocols.acp;
  if (acp.enabled) {
    protocolAdapters.push(
      createAcpAdapter({
        mountPath: acp.mountPath,
        token: acp.auth.token,
        operations: acp.checkout.operations,
        idempotency: acp.idempotency,
        ...(acp.discovery !== undefined ? { discovery: acp.discovery } : {}),
      }),
    );
  }

  const gateway = await createGateway({
    config,
    store,
    paymentProviders,
    authorizationProviders,
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
      authorization: authorizationProviders.map((provider) => provider.name),
    },
    'gateway listening',
  );

  // Printed, not only logged, so a presenter sees the settlement destination
  // without reading JSON logs. Public values only, never the facilitator signer.
  const { x402, mpp } = config.payments;
  if (x402?.enabled) {
    console.log('');
    console.log('  x402 settlement');
    // Origin only: Alchemy, Infura and QuickNode put the API key in the URL,
    // and REDACT_PATHS covers pino's structured fields, not console.log
    console.log(`    network      ${x402.network}  via ${rpcOrigin(x402.rpcUrl)}`);
    console.log(`    asset        ${x402.asset} (${x402.assetName} v${x402.assetVersion})`);
    console.log(`    pays to      ${x402.payTo}   <- merchant-controlled, not the gateway`);
    console.log(`    facilitator  ${x402.facilitator.mode}`);
    console.log('');
  }
  if (mpp?.enabled) {
    console.log('');
    console.log('  MPP settlement (charge, evm, authorization)');
    console.log(`    network      ${mpp.network}  via ${rpcOrigin(mpp.rpcUrl)}`);
    console.log(`    asset        ${mpp.asset} (${mpp.assetName} v${mpp.assetVersion})`);
    console.log(`    pays to      ${mpp.recipient}   (merchant-controlled; not gateway-owned)`);
    console.log(`    facilitator  ${mpp.facilitator.mode}`);
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
        for (const provider of authorizationProviders) provider.close();
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
