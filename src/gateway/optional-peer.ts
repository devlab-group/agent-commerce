import { CommerceError } from '../core';

// Node's ERR_MODULE_NOT_FOUND message for a bare specifier it could not resolve
const MISSING_PACKAGE = /Cannot find package '([^']+)'/;

/**
 * Loads the module behind an enabled config feature. A package that is not
 * installed becomes a CONFIG_INVALID naming the feature and the package,
 * instead of a resolver error pointing into a bundled chunk. Any other
 * failure, such as a missing file inside an installed package, is rethrown.
 */
export async function importOptionalPeer<T>(feature: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null)?.code !== 'ERR_MODULE_NOT_FOUND') throw cause;
    const pkg = MISSING_PACKAGE.exec((cause as Error).message)?.[1];
    if (pkg === undefined) throw cause;
    throw new CommerceError(
      'CONFIG_INVALID',
      `${feature} is enabled, but the package "${pkg}" is not installed. Install the ` +
        'optional peers it needs at the versions `agent-commerce version` lists, or ' +
        'disable it.',
      { cause },
    );
  }
}
