/**
 * Builds the A2A v1 Agent Card from canonical resources.
 *
 * One skill per resource exposed via `expose: [a2a]`, skill id = resource id.
 * A2A has no field for a skill's input schema, so the card shows the call
 * shape through fields it does define: a sentence in the agent description,
 * which also says where the schemas are published, and one example per skill.
 */
import { AUTHORIZATION_INPUT_FIELD, type CommerceResource, PAYMENT_INPUT_FIELD } from '../../core';
import { isRecord } from '../../core/is-record';
import { joinUrl } from '../http';
import { A2A_JSON_MEDIA_TYPE, A2A_PROTOCOL_BINDING, A2A_PROTOCOL_VERSION } from './constants';
import { A2A_CALL_SHAPE } from './message-mapping';
import type { A2aAgentCard, A2aAgentSkill } from './types';
import { A2A_X402_EXTENSION_URI, A2A_X402_PROTOCOL_VERSION } from './x402-extension';

// The gateway route that lists every resource with its input schema
const RESOURCES_PATH = '/api/resources';

export interface AgentCardOptions {
  readonly name: string;
  readonly description: string;
  /** Version of this gateway build, not of the protocol */
  readonly version: string;
  /** Externally reachable gateway base URL, from configuration */
  readonly publicBaseUrl: string;
  /** Gateway path the JSON-RPC endpoint is mounted at */
  readonly mountPath: string;
  readonly resources: readonly CommerceResource[];
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

/**
 * Build a sample from schema examples, defaults, enum values or the declared
 * type. Objects include required properties only. Other constraints may need
 * different input.
 */
function exampleValue(schema: unknown, name: string): unknown {
  if (!isRecord(schema)) return `<${name}>`;
  const examples = schema['examples'];
  if (Array.isArray(examples) && examples.length > 0) return examples[0];
  if (schema['default'] !== undefined) return schema['default'];
  const allowed = schema['enum'];
  if (Array.isArray(allowed) && allowed.length > 0) return allowed[0];
  const declared = schema['type'];
  const type: unknown = Array.isArray(declared) ? declared[0] : declared;
  switch (type) {
    case 'object':
      return exampleObject(schema);
    case 'array':
      return schema['items'] !== undefined ? [exampleValue(schema['items'], name)] : [];
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      return `<${name}>`;
  }
}

function exampleObject(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  const example: Record<string, unknown> = {};
  for (const key of required) {
    // The reserved fields carry proofs, which no example can hold
    if (typeof key !== 'string' || key === PAYMENT_INPUT_FIELD || key === AUTHORIZATION_INPUT_FIELD)
      continue;
    example[key] = exampleValue(properties[key], key);
  }
  return example;
}

/** The `data` value of a data part that calls the skill, as JSON */
function skillExample(resource: CommerceResource): string {
  return JSON.stringify({
    resource: resource.id,
    input: exampleObject(resource.inputSchema ?? {}),
  });
}

function buildAgentSkill(resource: CommerceResource): A2aAgentSkill {
  return {
    id: resource.id,
    name: resource.name,
    description: skillDescription(resource),
    tags: skillTags(resource),
    examples: [skillExample(resource)],
    inputModes: [A2A_JSON_MEDIA_TYPE],
    outputModes: [A2A_JSON_MEDIA_TYPE],
  };
}

function agentDescription(options: AgentCardOptions): string {
  const call = `Call a skill by sending ${A2A_CALL_SHAPE} with media type ${A2A_JSON_MEDIA_TYPE}. Each skill has an example; input schemas are at ${joinUrl(options.publicBaseUrl, RESOURCES_PATH)}.`;
  const pay = options.resources.some((resource) => resource.pricing.type !== 'free')
    ? ` For paid skills, retry with a payment proof in "input.${PAYMENT_INPUT_FIELD}".`
    : '';
  return `${options.description} ${call}${pay}`;
}

export function buildAgentCard(options: AgentCardOptions): A2aAgentCard {
  return {
    name: options.name,
    description: agentDescription(options),
    version: options.version,
    supportedInterfaces: [
      {
        url: joinUrl(options.publicBaseUrl, options.mountPath),
        protocolBinding: A2A_PROTOCOL_BINDING,
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      // Only a skill whose rail is x402 can be paid through the extension.
      // Not required: `_payment` keeps working for clients without it.
      ...(options.resources.some((resource) => resource.paymentMethods[0] === 'x402')
        ? {
            extensions: [
              {
                uri: A2A_X402_EXTENSION_URI,
                description: 'x402 payments: input-required tasks carrying x402 v2 documents.',
                required: false,
                // Lets a client holding an x402 v1 library tell before it pays
                params: { x402Version: A2A_X402_PROTOCOL_VERSION },
              },
            ],
          }
        : {}),
    },
    defaultInputModes: [A2A_JSON_MEDIA_TYPE],
    defaultOutputModes: [A2A_JSON_MEDIA_TYPE],
    skills: options.resources.map(buildAgentSkill),
  };
}
