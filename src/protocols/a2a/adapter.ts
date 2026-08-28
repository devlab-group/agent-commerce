/**
 * A2A (Agent2Agent) protocol adapter — experimental.
 *
 * Serves two paths: the configured mount (`/a2a`), where the JSON-RPC endpoint
 * lives, and the specification-fixed `/.well-known/agent-card.json`, declared
 * through `additionalHttpRoutes` so the gateway needs no A2A-specific routing.
 *
 * Only the synchronous `SendMessage` path is in scope; every other A2A method
 * is listed in `descriptor.unsupported` rather than half-served. This file
 * never calls a merchant backend and never inspects a payment object.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AdapterDescriptor,
  type AdapterHealth,
  type AdapterHttpRoute,
  type CommerceResource,
  type HttpProtocolAdapter,
  type ProtocolAdapterContext,
  toCommerceError,
} from '../../core/index.js';
import { PACKAGE_VERSION } from '../../version.js';
import { buildAgentCard } from './agent-card.js';
import {
  A2A_AGENT_CARD_PATH,
  A2A_DEFAULT_AGENT_NAME,
  A2A_DEFAULT_MOUNT_PATH,
  A2A_JSON_MEDIA_TYPE,
} from './constants.js';
import { buildDescriptor } from './descriptor.js';
import type { A2aAgentCard } from './types.js';

export interface A2aAdapterOptions {
  readonly mountPath?: string;
  /** Agent name published on the card. */
  readonly agentName?: string;
  readonly agentDescription?: string;
  /** Version published on the card. Defaults to this package's version. */
  readonly agentVersion?: string;
}

const DEFAULT_AGENT_DESCRIPTION =
  'Agent Commerce Gateway — canonical commerce resources exposed as A2A skills.';

export class A2aProtocolAdapter implements HttpProtocolAdapter {
  readonly name = 'a2a' as const;
  readonly mountPath: string;
  readonly descriptor: AdapterDescriptor;
  readonly additionalHttpRoutes: readonly AdapterHttpRoute[];

  private readonly agentName: string;
  private readonly agentDescription: string;
  private readonly agentVersion: string;

  private context: ProtocolAdapterContext | undefined;
  private started = false;
  private skills: readonly CommerceResource[] = [];
  // Built once at start: resources are fixed at config load, and a card
  // rebuilt per request would let a discovery GET do work a caller controls
  // the cost of.
  private card: A2aAgentCard | undefined;

  constructor(options: A2aAdapterOptions = {}) {
    this.mountPath = options.mountPath ?? A2A_DEFAULT_MOUNT_PATH;
    this.agentName = options.agentName ?? A2A_DEFAULT_AGENT_NAME;
    this.agentDescription = options.agentDescription ?? DEFAULT_AGENT_DESCRIPTION;
    this.agentVersion = options.agentVersion ?? PACKAGE_VERSION;
    this.descriptor = buildDescriptor(PACKAGE_VERSION);
    this.additionalHttpRoutes = [
      {
        method: 'GET',
        path: A2A_AGENT_CARD_PATH,
        handleHttp: (req, res) => this.handleAgentCard(req, res),
      },
    ];
  }

  async start(context: ProtocolAdapterContext): Promise<void> {
    this.context = context;
    this.started = false;

    let resources: readonly CommerceResource[] = [];
    try {
      resources = context.resources.listExposedVia('a2a');
    } catch (err) {
      context.logger.error(
        { err: toCommerceError(err).toInfo() },
        'a2a adapter: failed to list a2a-exposed resources',
      );
      resources = [];
    }

    this.skills = resources;
    this.card = buildAgentCard({
      name: this.agentName,
      description: this.agentDescription,
      version: this.agentVersion,
      publicBaseUrl: context.publicBaseUrl,
      mountPath: this.mountPath,
      resources,
    });
    this.started = true;

    context.logger.info(
      { mountPath: this.mountPath, cardPath: A2A_AGENT_CARD_PATH, skillCount: resources.length },
      'a2a adapter started',
    );
  }

  /** `GET /.well-known/agent-card.json`. */
  async handleAgentCard(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.started || this.card === undefined) {
        this.writeJson(res, 503, { error: 'A2A adapter is not running.' });
        return;
      }
      if (req.method !== 'GET') {
        this.writeJson(res, 405, { error: 'Method not allowed. The Agent Card is read-only.' });
        return;
      }
      this.writeJson(res, 200, this.card);
    } catch (err) {
      this.context?.logger.error(
        { err: toCommerceError(err).toInfo() },
        'a2a adapter: agent card request failed',
      );
      this.writeJson(res, 500, { error: 'Internal server error.' });
    }
  }

  async handleHttp(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The JSON-RPC endpoint arrives with the SendMessage transport. Until
    // then this answers honestly rather than 404-ing a path the card
    // advertises.
    this.writeJsonRpcError(res, 501, 'A2A SendMessage is not implemented yet.');
  }

  async health(): Promise<AdapterHealth> {
    const checkedAt = this.context?.clock.nowIso() ?? new Date().toISOString();
    if (!this.started || this.card === undefined) {
      return { status: 'fail', detail: 'A2A adapter has not been started.', checkedAt };
    }
    return { status: 'pass', detail: `${this.skills.length} skill(s) published.`, checkedAt };
  }

  async stop(): Promise<void> {
    this.started = false;
    this.card = undefined;
    this.skills = [];
    this.context = undefined;
  }

  private writeJson(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': A2A_JSON_MEDIA_TYPE });
    res.end(JSON.stringify(body));
  }

  private writeJsonRpcError(res: ServerResponse, status: number, message: string): void {
    this.writeJson(res, status, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32601, message },
    });
  }
}

export function createA2aAdapter(options: A2aAdapterOptions = {}): A2aProtocolAdapter {
  return new A2aProtocolAdapter(options);
}
