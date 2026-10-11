// A resource's backend request: input bindings, path parameters, URL and headers
import { CommerceError, RESERVED_INPUT_FIELDS } from '../../core';
import {
  extractPathParameterNames,
  findUnparsedBraceToken,
  isObjectSchemaNode,
} from '../../core/execution';
import { isRecord } from '../../core/is-record';
import type { RawResourceEntry } from './raw';

/**
 * Checks `backend.inputBindings` against the input schema at load. Schemas are
 * closed by default at every depth, so a binding naming an undeclared property
 * could never be supplied, and on a paid resource the backend would get an
 * incomplete request after payment.
 *
 * Returns the schema node `{param}` names must be declared in: the path group
 * with bindings, the whole input without.
 */
export function validateInputBindings(
  id: string,
  backend: RawResourceEntry['backend'],
  input: Record<string, unknown> | undefined,
): { readonly schema: Record<string, unknown> | undefined; readonly where: string } {
  const legacy = { schema: input, where: 'its input schema' } as const;
  const bindings = backend.inputBindings;
  const templated = extractPathParameterNames(backend.url).length > 0;
  if (bindings === undefined) return legacy;

  const path = `resources.${id}.backend.inputBindings`;
  const fail = (message: string, details: Record<string, unknown> = {}): never => {
    throw new CommerceError('CONFIG_INVALID', `Resource "${id}" ${message}`, {
      details: { path, resourceId: id, ...details },
    });
  };

  const entries = Object.entries(bindings).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (entries.length === 0) {
    fail('has an empty backend.inputBindings - remove the block to use the default mapping');
  }
  if (backend.method === 'GET' || backend.method === 'DELETE') {
    if (bindings.body !== undefined) {
      fail(
        `binds a request body on a ${backend.method}, which sends none - the value would be silently dropped`,
      );
    }
  }
  if (templated && bindings.path === undefined) {
    fail(
      'has backend.url path parameters but no "path" binding - in explicit binding mode nothing else supplies them, so every call would fail to reach the backend',
    );
  }

  const seen = new Map<string, string>();
  const properties = isRecord(input?.['properties']) ? input['properties'] : {};
  const required = new Set(
    Array.isArray(input?.['required'])
      ? input['required'].filter((value): value is string => typeof value === 'string')
      : [],
  );

  for (const [location, property] of entries) {
    if (RESERVED_INPUT_FIELDS.includes(property)) {
      fail(`binds "${location}" to "${property}", which is reserved by the gateway`, { location });
    }
    const other = seen.get(property);
    if (other !== undefined) {
      fail(`binds both "${other}" and "${location}" to the input property "${property}"`, {
        location,
        property,
      });
    }
    seen.set(property, location);

    if (!Object.hasOwn(properties, property)) {
      fail(
        `binds "${location}" to input property "${property}", which the input schema does not declare - the schema is closed, so a caller could never supply it`,
        { location, property },
      );
    }
    // `body` may be any JSON value; only the path and query groups are read as
    // name/value pairs
    const declared = properties[property];
    if (location !== 'body' && isRecord(declared) && !isObjectSchemaNode(declared)) {
      fail(
        `binds "${location}" to input property "${property}", which is not an object schema - ${location} parameters are read as an object of name/value pairs`,
        { location, property },
      );
    }
  }

  if (templated && bindings.path !== undefined && !required.has(bindings.path)) {
    fail(
      `binds path parameters to input property "${bindings.path}" without listing it in the input schema's "required" - a caller that omits it cannot supply any path parameter, so the request could never be built`,
      { property: bindings.path },
    );
  }

  if (bindings.path === undefined) return { schema: undefined, where: 'its input schema' };
  const group = properties[bindings.path];
  return {
    schema: isRecord(group) ? group : undefined,
    where: `input.properties.${bindings.path}`,
  };
}

/**
 * Every `{param}` in `backend.url` must be declared in `properties` and listed
 * in `required`. Otherwise a call can arrive without it, and core's
 * `validateBackendRequestShape` rejects the request, which for a schema that
 * never declares the parameter means every call. Checked at load so
 * `validate` and `doctor` report it; the runtime check covers a hand-built
 * `CommerceResource`.
 */
export function validatePathParametersDeclared(
  id: string,
  url: string,
  input: Record<string, unknown> | undefined,
  where: string,
): void {
  // A brace token the grammar does not recognize is neither extracted nor
  // substituted, so it would reach the backend as a percent-encoded literal
  const stray = findUnparsedBraceToken(url);
  if (stray !== undefined) {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has backend.url containing "${stray}", which is not a valid path parameter (allowed characters: A-Z a-z 0-9 _ . -). It would reach the backend as literal text, so a paid resource would take payment for a request the backend cannot serve`,
      { details: { path: `resources.${id}.backend.url`, resourceId: id, token: stray } },
    );
  }

  const params = extractPathParameterNames(url);
  if (params.length === 0) return;

  // Everything before the first `{` must be a complete origin followed by the
  // path's leading `/`. In the host, every other `{param}` defense fails open:
  // `http://{host}/api` parses, the runtime prefix check skips a prefix that
  // is not a URL, and `encodeURIComponent` keeps dots. Caller input would pick
  // the host the gateway calls, such as a metadata service or an internal
  // address, and `http://{region}.api.internal/...` looks ordinary enough to
  // be written by mistake.
  const firstBrace = url.indexOf('{');
  if (firstBrace !== -1) {
    const prefix = url.slice(0, firstBrace);
    let origin: string | undefined;
    try {
      const parsedPrefix = new URL(prefix);
      origin = parsedPrefix.hostname === '' ? undefined : parsedPrefix.origin;
    } catch {
      // Not a URL: the parameter starts before the authority is complete
    }
    if (origin === undefined || !prefix.startsWith(`${origin}/`)) {
      // The URL is not quoted: it may carry a key substituted from the environment
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has a backend.url parameter before the end of the host. A caller-supplied value would choose which host the gateway calls, which is request forgery with the gateway's own network position. Parameters are supported inside the path and query only`,
        { details: { path: `resources.${id}.backend.url`, resourceId: id } },
      );
    }
  }

  const propertiesRaw = input?.['properties'];
  const properties = isRecord(propertiesRaw) ? propertiesRaw : {};
  const requiredRaw = input?.['required'];
  const required = new Set(
    Array.isArray(requiredRaw)
      ? requiredRaw.filter((entry): entry is string => typeof entry === 'string')
      : [],
  );

  for (const param of params) {
    const path = `resources.${id}.backend.url`;
    if (!Object.hasOwn(properties, param)) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has backend.url path parameter "{${param}}" which is not declared in ${where} - the caller has no way to supply it, so every call would be refused`,
        { details: { path, resourceId: id, param } },
      );
    }
    if (!required.has(param)) {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has backend.url path parameter "{${param}}" declared in ${where} but not listed in its "required" - a call that omits it would be refused`,
        { details: { path, resourceId: id, param } },
      );
    }
  }
}

// `{param}` templates parse as URLs (the WHATWG parser percent-encodes the
// braces), so this refuses only malformed URLs and non-http(s) schemes
export function validateBackendUrl(id: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The URL is not quoted: it may carry a key substituted from the environment
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has an invalid backend.url: must be an absolute http:// or https:// URL`,
      { details: { path: `resources.${id}.backend.url`, resourceId: id } },
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CommerceError(
      'CONFIG_INVALID',
      `Resource "${id}" has a backend.url with scheme "${parsed.protocol}": must be http:// or https://`,
      { details: { path: `resources.${id}.backend.url`, resourceId: id } },
    );
  }
}

// Checked with fetch's own `Headers` rules. Otherwise an illegal name, or a
// substituted value with a line break inside it, would load cleanly and then
// refuse every call. The error names the key, never the value, which may be a
// credential.
export function validateBackendHeaders(
  id: string,
  headers: Record<string, string> | undefined,
): void {
  for (const [name, value] of Object.entries(headers ?? {})) {
    try {
      new Headers([[name, value]]);
    } catch {
      throw new CommerceError(
        'CONFIG_INVALID',
        `Resource "${id}" has backend header "${name}" with an illegal name or value (a name must be an HTTP token; a value must not contain NUL, a character above U+00FF, or a line break except at either end, which fetch trims)`,
        { details: { path: `resources.${id}.backend.headers.${name}`, resourceId: id } },
      );
    }
  }
}
