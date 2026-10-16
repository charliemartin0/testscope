const cache = new Map<string, RegExp>();

/** Convert a glob (`**`, `*`, `?`) to an anchored RegExp. `**\/` matches zero or more directories. */
export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const regex = new RegExp(`^${source}$`);
  cache.set(glob, regex);
  return regex;
}

export function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

export function firstMatch(files: string[], globs: string[]): string | null {
  return files.find((file) => matchesAny(file, globs)) ?? null;
}

/** Join a working directory ('' = root) with a relative pattern. */
export function underDir(directory: string, pattern: string): string {
  return directory ? `${directory}/${pattern}` : pattern;
}
