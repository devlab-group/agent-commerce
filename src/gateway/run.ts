/**
 * Concrete startup shared by `main.ts` and `agent-commerce start`.
 *
 * Await enabled rail, AP2 and MCP imports before opening replay stores, so
 * missing startup peers leave no database behind. Solana, NEAR and CDP loads
 * begin during provider construction, but their errors surface in health
 * checks or requests. Store failures abort startup; adapter start failures
 * are isolated. `createGateway` accepts injected implementations without
 * importing this module.
 */
import type { Ap2AuthorizationProvider } from '../authorization/ap2';
import { loadConfig } from '../config';
import type { X402OptionConfig } from '../config/schema';
import type { ProtocolAdapter, ReceiptStore } from '../core';
import { CommerceError, isCommerceError } from '../core';
import { createA2aAdapter } from '../protocols/a2a';
import { createAcpAdapter } from '../protocols/acp';
import { createSqliteReceiptStore } from '../storage/receipts';

import { createGatewayLogger } from './logger';
import { importOptionalPeer } from './optional-peer';
import { createConfiguredPaymentProviders } from './payment-providers';
import { createGateway } from './server';

/** Options for `runGateway` */
export interface RunGatewayOptions {
  /** Config file path; defaults to `AGENT_COMMERCE_CONFIG`, then `./config.yaml` */
  readonly configPath?: string;
}

// The host a presenter needs, without the credential a provider puts in the path
function rpcOrigin(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).origin;
  } catch {
    return '[unparseable rpcUrl]';
  }
}

/** Starts the gateway and registers SIGTERM and SIGINT shutdown handlers */
export async function runGateway(options: RunGatewayOptions = {}): Promise<void> {
  const config = await loadConfig(
    options.configPath !== undefined ? { path: options.configPath } : {},
  );

  const { core: logger } = createGatewayLogger({ name: config.merchant.id });

  const paymentProviders = await createConfiguredPaymentProviders(config.payments, logger);
  const ap2 = config.authorization?.ap2;
  const ap2Module = ap2?.enabled
    ? await importOptionalPeer('authorization.ap2', () => import('../authorization/ap2'))
    : undefined;
  const mcp = config.protocols.mcp;
  const mcpModule = mcp.enabled
    ? await importOptionalPeer('protocols.mcp', () => import('../protocols/mcp'))
    : undefined;

  const store: ReceiptStore = createSqliteReceiptStore({
    path: config.storage.receipts.path,
    logger,
  });
  await store.init();

  // Built only when enabled: the constructor opens the replay database, so a
  // disabled AP2 block creates no file and holds no handle
  const authorizationProviders: Ap2AuthorizationProvider[] = [];
  if (ap2?.enabled && ap2Module !== undefined) {
    authorizationProviders.push(ap2Module.createAp2AuthorizationProvider({ config: ap2, logger }));
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
  if (mcpModule !== undefined) {
    protocolAdapters.push(mcpModule.createMcpAdapter({ mountPath: mcp.mountPath }));
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
    // Print each offer's RPC origin only: URLs may contain API keys, and
    // pino's REDACT_PATHS does not protect console.log
    const printOffer = (option: X402OptionConfig, indent = '') => {
      console.log(`${indent}    network      ${option.network}  via ${rpcOrigin(option.rpcUrl)}`);
      const domain = option.assetName ? ` (${option.assetName} v${option.assetVersion})` : '';
      const method = option.assetTransferMethod === 'permit2' ? ' via Permit2' : '';
      console.log(`${indent}    asset        ${option.asset}${domain}${method}`);
      console.log(
        `${indent}    pays to      ${option.payTo}   <- merchant-controlled, not the gateway`,
      );
    };
    for (const option of x402.options ?? [x402]) printOffer(option);
    for (const [id, list] of Object.entries(x402.resourceOptions ?? {})) {
      console.log(`    resource     ${id} (its own offers)`);
      for (const option of list) printOffer(option, '  ');
    }
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

/** Prints typed startup errors as `CODE: message` and other errors with a startup label */
export function printStartupError(error: unknown): void {
  // Typed errors retain their authored message and details
  if (isCommerceError(error)) {
    console.error(`\n  ${error.code}: ${error.message}\n`);
    if (error.details) console.error(`  ${JSON.stringify(error.details)}\n`);
  } else {
    console.error('\n  Gateway failed to start:', error instanceof Error ? error.message : error);
    console.error('');
  }
}
