/**
 * Builds the A2A v1 Agent Card from canonical resources.
 *
 * One skill per resource exposed via `expose: [a2a]`, skill id = resource id.
 * The card is a *discovery* document: it says what exists and how to reach the
 * endpoint, not how to call a skill. The invocation envelope is the adapter's
 * concern.
 */
import type { CommerceResource } from '../../core/index.js';
import { A2A_JSON_MEDIA_TYPE, A2A_PROTOCOL_BINDING, A2A_PROTOCOL_VERSION } from './constants.js';
import type { A2aAgentCard, A2aAgentSkill } from './types.js';

export interface AgentCardOptions {
  readonly name: string;
  readonly description: string;
  /** Version of this gateway build, not of the protocol. */
  readonly version: string;
  /** Externally reachable gateway base URL, from configuration. */
  readonly publicBaseUrl: string;
  /** Gateway path the JSON-RPC endpoint is mounted at. */
  readonly mountPath: string;
  readonly resources: readonly CommerceResource[];
}

/**
 * A base URL may or may not carry a trailing slash and a mount always starts
 * with one; concatenating them naively yields `https://host//a2a`, which is a
 * different path to every router that sees it.
 */
export function endpointUrl(publicBaseUrl: string, mountPath: string): string {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const path = mountPath.startsWith('/') ? mountPath : `/${mountPath}`;
  return `${base}${path.replace(/\/+$/, '')}`;
}

/**
 * Free/paid is on the card because a caller choosing between skills should not
 * have to attempt a call to discover one costs money. The price itself is in
 * the description, where a human-readable amount belongs.
 */
function skillTags(resource: CommerceResource): string[] {
  return ['agent-commerce', resource.pricing.type === 'free' ? 'free' : 'paid'];
}

function skillDescription(resource: CommerceResource): string {
  const base = resource.description ?? resource.name;
  if (resource.pricing.type === 'fixed') {
    return `${base} Costs ${resource.pricing.amount} ${resource.pricing.currency} per call.`;
  }
  if (resource.pricing.type === 'dynamic') {
    return `${base} Requires payment (amount determined at request time).`;
  }
  return base;
}

export function buildAgentSkill(resource: CommerceResource): A2aAgentSkill {
  return {
    id: resource.id,
    name: resource.name,
    description: skillDescription(resource),
    tags: skillTags(resource),
    inputModes: [A2A_JSON_MEDIA_TYPE],
    outputModes: [A2A_JSON_MEDIA_TYPE],
  };
}

export function buildAgentCard(options: AgentCardOptions): A2aAgentCard {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: options.name,
    description: options.description,
    version: options.version,
    supportedInterfaces: [
      {
        url: endpointUrl(options.publicBaseUrl, options.mountPath),
        protocolBinding: A2A_PROTOCOL_BINDING,
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: [A2A_JSON_MEDIA_TYPE],
    defaultOutputModes: [A2A_JSON_MEDIA_TYPE],
    skills: options.resources.map(buildAgentSkill),
  };
}
