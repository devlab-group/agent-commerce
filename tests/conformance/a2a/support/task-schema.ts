/**
 * Validate responses offline with the TCK schema vendored in
 * `tests/fixtures/a2a/`, resolving filename references to local definitions.
 * Task and response-envelope definitions reject undeclared properties;
 * definitions for arbitrary JSON payloads remain open.
 */
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const SCHEMA_PATH = 'tests/fixtures/a2a/tck-5e6f37c2/a2a.json';

/** Vendored schema definitions used by the tests, identified by title */
export type TckDefinition = 'Task' | 'Send Message Response' | 'List Tasks Response';

// Map lf.a2a.v1.TaskStatus.jsonschema.json to "Task Status"
// and google.protobuf.Value.jsonschema.json to "Value"
function localRefs(schema: { definitions: Record<string, unknown> }): unknown {
  const byFile = new Map<string, string>();
  for (const name of Object.keys(schema.definitions)) {
    byFile.set(`lf.a2a.v1.${name.replaceAll(' ', '')}.jsonschema.json`, name);
    byFile.set(`google.protobuf.${name}.jsonschema.json`, name);
  }
  return JSON.parse(JSON.stringify(schema), (key, value: unknown) => {
    if (key !== '$ref' || typeof value !== 'string') return value;
    const name = byFile.get(value);
    if (name === undefined) throw new Error(`Unmapped $ref ${value}`);
    return `#/definitions/${encodeURIComponent(name)}`;
  });
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(localRefs(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))) as object, 'a2a');

/** Return validation errors against the named definition, or an empty list */
export function tckErrors(definition: TckDefinition, value: unknown): string[] {
  const validate = ajv.getSchema(`a2a#/definitions/${encodeURIComponent(definition)}`);
  if (validate === undefined) throw new Error(`No TCK definition "${definition}"`);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
}
