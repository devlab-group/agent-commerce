import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Writes `content` to a temporary sibling, then renames it over `outputPath`.
 * The destination is replaced after the write succeeds, so a failed write
 * leaves an existing file intact. Creates missing output directories.
 */
export async function writeAtomically(outputPath: string, content: string): Promise<void> {
  const target = resolve(outputPath);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
