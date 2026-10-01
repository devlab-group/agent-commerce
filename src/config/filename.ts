/**
 * The default configuration filename, shared by the loader, `init`'s default
 * output path and the `--config` help text.
 *
 * Its own module with no imports: `src/cli` loads the rest of `src/config`
 * only through a dynamic import (`src/cli/lib/config-client.ts`), so a broken
 * config module cannot take down commands that never read configuration. A
 * leaf with no module graph can be imported statically without undoing that.
 */
export const DEFAULT_CONFIG_FILENAME = 'config.yaml';
