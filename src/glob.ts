const cache = new Map<string, RegExp>();

/** Minimal glob matcher: `**`, `*`, `?`, `{a,b}`. Paths use forward slashes. */
export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      depth++;
      re += '(?:';
    } else if (c === '}' && depth) {
      depth--;
      re += ')';
    } else if (c === ',' && depth) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export function matchesAny(file: string, globs: readonly string[]): string | undefined {
  return globs.find((g) => globToRegExp(g).test(file));
}
