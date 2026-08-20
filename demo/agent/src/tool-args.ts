/**
 * Discovers which MCP tools are free vs paid, and synthesises call arguments
 * from a tool's JSON-Schema `inputSchema` — generic enough for any resource,
 * with one named-parameter special case ("city") matching this repo's own
 * demo config (config.example.yaml's `weather_basic` resource).
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { PAYMENT_INPUT_FIELD } from '../../../src/core/index.js';

/** A tool is "paid" iff the gateway added the reserved `_payment` input property (tool-mapping.ts). */
export function isPaidTool(tool: Tool): boolean {
  const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
  return properties !== undefined && Object.hasOwn(properties, PAYMENT_INPUT_FIELD);
}

export function buildToolArguments(tool: Tool): Record<string, unknown> {
  const schema = tool.inputSchema;
  const properties = (schema.properties ?? {}) as Record<string, { type?: unknown }>;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];

  const args: Record<string, unknown> = {};
  for (const key of required) {
    if (typeof key !== 'string' || key === PAYMENT_INPUT_FIELD) continue;
    args[key] = exampleValueFor(key, properties[key]?.type);
  }
  return args;
}

function exampleValueFor(key: string, type: unknown): unknown {
  if (key.toLowerCase() === 'city') return 'Paris';
  switch (type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return true;
    default:
      return 'demo';
  }
}
