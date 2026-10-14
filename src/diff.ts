import type { ChangeStatus, ChangedFile } from './types.ts';

const STATUS: Record<string, ChangeStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
};

/** Parse `git diff --name-status -z -M` output. */
export function parseNameStatus(output: string): ChangedFile[] {
  const parts = output.split('\0').filter((p) => p !== '');
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++] as string;
    const status = STATUS[code[0] ?? ''] ?? 'other';
    if (status === 'renamed' || status === 'copied') {
      const oldPath = parts[i++];
      const path = parts[i++];
      if (oldPath === undefined || path === undefined)
        throw new Error('Truncated name-status output');
      files.push({ status, path, oldPath });
    } else {
      const path = parts[i++];
      if (path === undefined) throw new Error('Truncated name-status output');
      files.push({ status, path });
    }
  }
  return files;
}
