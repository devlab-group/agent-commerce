// MCP Registry field rules for `protocols.mcp.registry`, based on
// `modelcontextprotocol/registry@115f8522`, `internal/validators/validators.go`
import { z } from 'zod';

// `serverNameRegex`: one slash, and at least two characters on each side
const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]\/[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$/;

// Preserve the upstream range patterns. RE2's `\s` matches [\t\n\f\r ],
// a narrower set than JavaScript's.
const re2 = (source: string) =>
  new RegExp(source.replaceAll(String.raw`\s`, String.raw`[\t\n\f\r ]`));
const RANGES = [
  // `comparatorRangeRe`, `hyphenRangeRe`, `orRangeRe`
  String.raw`^\s*(?:\^|~|>=|<=|>|<|=)\s*v?\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?\s*$`,
  String.raw`^\s*v?\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?\s-\s*v?\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?\s*$`,
  String.raw`^\s*(?:v?\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?\s*)(?:\|\|\s*v?\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?\s*)+$`,
].map(re2);
// `dottedVersionLikeRe`
const DOTTED_VERSION_LIKE = re2(
  String.raw`^\s*(?:v?\d+|x|X|\*)(?:\.(?:\d+|x|X|\*)){1,2}(?:-[0-9A-Za-z.-]+)?\s*$`,
);

// Match `looksLikeVersionRange`: a dotted version containing `x`, `X` or `*`
// counts as a range, even in the prerelease part of `1.0.0-next.1`
function looksLikeVersionRange(version: string): boolean {
  // Go's strings.TrimSpace trims Unicode White_Space
  const trimmed = version.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  if (trimmed === '') return false;
  if (RANGES.some((range) => range.test(trimmed))) return true;
  return DOTTED_VERSION_LIKE.test(trimmed) && /[xX*]/.test(trimmed);
}

// Lengths in code points, as JSON Schema and the registry count them
const codePoints = (min: number, max: number) =>
  z.string().refine(
    (value) => {
      const length = [...value].length;
      return length >= min && length <= max;
    },
    { message: `must be ${min} to ${max} characters` },
  );

export const McpRegistrySchema = z
  .object({
    name: z.string().max(200).regex(SERVER_NAME, {
      message:
        'must be a namespace and a name joined by one "/", such as io.github.acme/weather. Each side has at least 2 characters and starts and ends with a letter or digit; the namespace may also hold "." and "-", the name ".", "_" and "-".',
    }),
    version: codePoints(1, 255)
      .refine((value) => value !== 'latest', {
        message: 'must not be "latest", which the MCP Registry reserves',
      })
      .refine((value) => !looksLikeVersionRange(value), {
        message:
          'must name one version, not a range such as ^1.2.3, 1.x or 1.0 - 2.0. The MCP Registry also reads a dotted version holding x, X or * anywhere, such as 1.0.0-next.1, as a range.',
      }),
    description: codePoints(1, 100),
  })
  .strict();
