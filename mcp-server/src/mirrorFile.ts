import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function readMirror(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function writeMirrorAtomic(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });

  const tempPath = join(directory, `bookmarks.json.${randomUUID()}.tmp`);
  await writeFile(tempPath, content, 'utf8');

  try {
    await rename(tempPath, path);
  } catch (error: unknown) {
    try {
      await unlink(tempPath);
    } catch {
      // Best-effort cleanup must not replace the original rename error.
    }
    throw error;
  }
}
