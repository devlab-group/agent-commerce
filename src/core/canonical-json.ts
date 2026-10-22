// RFC 8785 (JCS) serialization for request hashes

// With the `u` flag, a valid surrogate pair is one code point, so this pattern
// matches only lone surrogates
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Serializes JSON data using RFC 8785 (JCS) rules. Non-finite numbers, lone
 * surrogates and unsupported primitive values return undefined.
 * JSON.stringify supplies number formatting and string escaping; the default
 * sort orders keys by UTF-16 code units.
 */
export function canonicalJson(value: unknown): string | undefined {
  if (typeof value === 'string')
    return LONE_SURROGATE.test(value) ? undefined : JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson);
    return items.includes(undefined) ? undefined : `[${items.join(',')}]`;
  }
  if (typeof value !== 'object') return undefined;
  const members: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const member = canonicalJson((value as Record<string, unknown>)[key]);
    if (member === undefined || LONE_SURROGATE.test(key)) return undefined;
    members.push(`${JSON.stringify(key)}:${member}`);
  }
  return `{${members.join(',')}}`;
}
