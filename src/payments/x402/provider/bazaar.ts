// Build HTTP and MCP Bazaar metadata without loading an SDK. Config loading
// can use these helpers to report omitted resources and surfaces before startup.
import type { CommerceResource } from '../../../core';
import { validateBackendRequestShape } from '../../../core/execution/backend-request';
import {
  exampleObject,
  exampleValue,
  objectInputSchema,
} from '../../../core/execution/schema-example';
import { compileJsonSchema, isFullyEnforced } from '../../../core/execution/validation';

/** The extension's key in a challenge's `extensions` */
export const BAZAAR_EXTENSION_KEY = 'bazaar';

/** Maximum serialized extension size accepted by `bazaarMetadata`, in bytes */
export const MAX_BAZAAR_EXTENSION_BYTES = 4096;

/** Maximum description length accepted by `bazaarMetadata` */
export const MAX_BAZAAR_DESCRIPTION_LENGTH = 500;

/** Experimental. One surface's `extensions.bazaar` value */
export interface BazaarExtension {
  readonly info: Readonly<Record<string, unknown>>;
  readonly schema: Readonly<Record<string, unknown>>;
}

/** Supported Bazaar metadata surfaces */
export type BazaarSurface = 'http' | 'mcp';

export interface BazaarMetadata {
  readonly extensions: Partial<Record<BazaarSurface, BazaarExtension>>;
  /** Omission reasons and affected surfaces, for config-load warnings */
  readonly omitted: readonly {
    readonly surfaces: readonly BazaarSurface[];
    readonly reason: string;
  }[];
}

const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Build Bazaar extensions for the requested surfaces. Metadata is omitted
 * unless the generated example passes the input schema and backend request
 * shape checks, and the schema uses the validator's supported subset. This
 * avoids publishing examples that fail gateway validation before pricing.
 */
export function bazaarMetadata(
  resource: CommerceResource,
  surfaces: readonly BazaarSurface[],
): BazaarMetadata {
  if (surfaces.length === 0) return { extensions: {}, omitted: [] };
  const all = (reason: string): BazaarMetadata => ({
    extensions: {},
    omitted: [{ surfaces, reason }],
  });

  const description = resource.description ?? resource.name;
  if (description.length > MAX_BAZAAR_DESCRIPTION_LENGTH) {
    return all(
      `its description is longer than ${MAX_BAZAAR_DESCRIPTION_LENGTH} characters, which the CDP facilitator refuses`,
    );
  }
  const schema = resource.inputSchema ?? {};
  if (!isFullyEnforced(schema)) {
    return all(
      'its input schema uses a keyword the gateway does not enforce, which leaves the example unproven',
    );
  }
  const example = exampleObject(schema);
  if (!compileJsonSchema(schema)(example).valid || !shapeAccepts(resource, example)) {
    return all('the example generated from its input schema fails the gateway input checks');
  }

  const built = {
    http: () => httpForm(resource, schema, example),
    mcp: () => mcpForm(resource, description, example),
  };
  const extensions: Partial<Record<BazaarSurface, BazaarExtension>> = {};
  const oversized: BazaarSurface[] = [];
  for (const surface of surfaces) {
    const extension = built[surface]();
    if (Buffer.byteLength(JSON.stringify(extension)) > MAX_BAZAAR_EXTENSION_BYTES) {
      oversized.push(surface);
    } else {
      extensions[surface] = extension;
    }
  }
  return {
    extensions,
    omitted:
      oversized.length > 0
        ? [
            {
              surfaces: oversized,
              reason: `the extension exceeds ${MAX_BAZAAR_EXTENSION_BYTES} bytes`,
            },
          ]
        : [],
  };
}

function shapeAccepts(resource: CommerceResource, example: unknown): boolean {
  try {
    validateBackendRequestShape(resource.handler, example, {
      requestId: 'bazaar-example',
      resourceId: resource.id,
    });
    return true;
  } catch {
    return false;
  }
}

// The invoke route takes the input as a JSON body
function httpForm(
  resource: CommerceResource,
  schema: Record<string, unknown>,
  example: Record<string, unknown>,
): BazaarExtension {
  const output = outputExample(resource.outputSchema);
  return {
    info: {
      input: { type: 'http', method: 'POST', bodyType: 'json', body: example },
      output: { type: 'json', ...(output !== undefined ? { example: output } : {}) },
    },
    schema: {
      $schema: JSON_SCHEMA_2020_12,
      type: 'object',
      properties: {
        input: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'http' },
            method: { type: 'string', enum: ['POST'] },
            bodyType: { type: 'string', enum: ['json'] },
            body: schema,
          },
          required: ['type', 'method', 'bodyType', 'body'],
          additionalProperties: false,
        },
        output: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            ...(output !== undefined ? { example: resource.outputSchema } : {}),
          },
          required: ['type'],
        },
      },
      required: ['input'],
    },
  };
}

// A tool is keyed by its endpoint URL and `toolName`, the resource id
function mcpForm(
  resource: CommerceResource,
  description: string,
  example: Record<string, unknown>,
): BazaarExtension {
  return {
    info: {
      input: {
        type: 'mcp',
        toolName: resource.id,
        description,
        inputSchema: objectInputSchema(resource.inputSchema),
        example,
      },
    },
    schema: {
      $schema: JSON_SCHEMA_2020_12,
      type: 'object',
      properties: {
        input: {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'mcp' },
            toolName: { type: 'string' },
            description: { type: 'string' },
            inputSchema: { type: 'object' },
            example: { type: 'object' },
          },
          required: ['type', 'toolName', 'inputSchema'],
          additionalProperties: false,
        },
      },
      required: ['input'],
    },
  };
}

// Publish an output example only when its schema uses the supported subset
// and local validation accepts it; runtime delivery does not validate output schemas
function outputExample(schema: Record<string, unknown> | undefined): unknown {
  if (schema === undefined || !isFullyEnforced(schema)) return undefined;
  const example = exampleValue(schema, 'output');
  return compileJsonSchema(schema)(example).valid ? example : undefined;
}
