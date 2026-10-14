/**
 * Nano payments: the buyer publishes a send block to `payTo` and presents its
 * hash. There is nothing to sign for the gateway and nothing to broadcast, so
 * no facilitator is involved: the gateway reads the block from a Nano node's
 * RPC and checks that the network confirmed it, that it sends to `payTo`,
 * and that it sends at least the offered amount. The block hash is the replay
 * key, so one send pays for one request.
 *
 * The provider loads this module only for a Nano offer.
 */
import { CommerceError } from '../../core';
import { isRecord } from '../../core/is-record';
import { normalizeNanoAddress } from './nano-address';
import { computeNanoReplayKey } from './replay-key';

/** One Nano node RPC call: the request body in, the parsed response body out */
export type NanoRpc = (request: Readonly<Record<string, unknown>>) => Promise<unknown>;

const BLOCK_HASH = /^[0-9A-Fa-f]{64}$/;
const RAW_AMOUNT = /^\d{1,40}$/;

/** A fetch-based `NanoRpc` against a node's HTTP RPC, bounded by `timeoutMs` */
export function createNanoRpc(rpcUrl: string, timeoutMs: number): NanoRpc {
  return async (request) => {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new CommerceError(
        'PAYMENT_PROVIDER_UNAVAILABLE',
        `Nano RPC ${String(request['action'])} returned HTTP ${response.status}`,
      );
    }
    return response.json();
  };
}

/**
 * Returns the block hash and replay key of a Nano payload, `{ blockHash }`
 * with 64 hex characters, or a refusal reason
 */
export function inspectNanoPayload(
  payload: unknown,
  network: string,
): { readonly blockHash: string; readonly replayKey: string } | string {
  const blockHash = isRecord(payload) ? payload['blockHash'] : undefined;
  if (typeof blockHash !== 'string' || !BLOCK_HASH.test(blockHash)) {
    return 'invalid_exact_nano_payload_block_hash';
  }
  const canonical = blockHash.toUpperCase();
  return {
    blockHash: canonical,
    replayKey: computeNanoReplayKey({ network, blockHash: canonical }),
  };
}

export interface NanoSendTerms {
  readonly blockHash: string;
  /** The offer's payee, a `nano_` address */
  readonly payTo: string;
  /** Raw units the send must carry at least */
  readonly amount: bigint;
}

/**
 * Reads the block and checks it against the offer. Returns the sender and the
 * raw amount sent, or a refusal reason. Throws `PAYMENT_PROVIDER_UNAVAILABLE`
 * when the node does not answer or answers something it cannot read, since
 * that is no verdict on the payment.
 */
export async function checkNanoSend(
  rpc: NanoRpc,
  terms: NanoSendTerms,
): Promise<{ readonly payer: string; readonly amount: bigint } | string> {
  let info: unknown;
  try {
    info = await rpc({ action: 'block_info', json_block: 'true', hash: terms.blockHash });
  } catch (cause) {
    throw unavailable('block_info failed', cause);
  }
  if (!isRecord(info)) throw unavailable('block_info returned no object');
  if (info['error'] !== undefined) {
    // A block the node has not seen may still arrive; anything else is the node's fault
    if (info['error'] === 'Block not found') return 'invalid_exact_nano_block_not_found';
    throw unavailable('block_info returned an error');
  }
  const contents = info['contents'];
  const amount = info['amount'];
  if (!isRecord(contents) || typeof amount !== 'string' || !RAW_AMOUNT.test(amount)) {
    throw unavailable('block_info returned an unreadable block');
  }
  // Only a cemented block is final; the node reports it as a string
  if (info['confirmed'] !== 'true' && info['confirmed'] !== true) {
    return 'invalid_exact_nano_block_unconfirmed';
  }
  if (contents['type'] !== 'state' || info['subtype'] !== 'send') {
    return 'invalid_exact_nano_block_not_send';
  }
  const recipient =
    typeof contents['link_as_account'] === 'string'
      ? normalizeNanoAddress(contents['link_as_account'])
      : undefined;
  if (recipient === undefined || recipient !== normalizeNanoAddress(terms.payTo)) {
    return 'invalid_exact_nano_recipient_mismatch';
  }
  const sent = BigInt(amount);
  if (sent < terms.amount) return 'invalid_exact_nano_amount_insufficient';
  const account = info['block_account'] ?? contents['account'];
  const payer = typeof account === 'string' ? normalizeNanoAddress(account) : undefined;
  if (payer === undefined) throw unavailable('block_info returned no valid sender');
  return { payer, amount: sent };
}

/** True when the node answers `version` for the live network */
export async function isLiveNanoNode(rpc: NanoRpc): Promise<boolean> {
  const version = await rpc({ action: 'version' });
  return isRecord(version) && version['network'] === 'live';
}

function unavailable(reason: string, cause?: unknown): CommerceError {
  return new CommerceError(
    'PAYMENT_PROVIDER_UNAVAILABLE',
    `x402 provider: Nano RPC ${reason}`,
    cause !== undefined ? { cause } : undefined,
  );
}
