/**
 * The default configuration filename, in one place.
 *
 * Deliberately its own module with **no imports**: `src/cli` reaches the rest
 * of `src/config` only through a dynamic import (see
 * `src/cli/lib/config-client.ts`), so that a broken config module cannot take
 * down commands that never read configuration. A leaf file holding a single
 * string has no module graph to break, so the CLI can import it directly
 * without reopening that seam — and `init`'s default output path, `--config`'s
 * help text and the loader's own lookup cannot drift apart, which is what
 * three separate copies of this string invited.
 */
export const DEFAULT_CONFIG_FILENAME = 'config.yaml';
