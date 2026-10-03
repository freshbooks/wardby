/**
 * Converts a glob pattern (with *, **, and ? support) to a regular expression.
 * - `*` matches any characters except `/` (one path segment)
 * - `**` matches any characters including `/` (any depth)
 * - `?` matches any single character except `/`
 * - Other regex metacharacters are escaped
 */
export function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

/** Whether a repo-relative POSIX path matches a protectedPaths-style glob (*, **, ?). */
export function matchesGlob(path: string, pattern: string): boolean {
  return globRegex(pattern).test(path);
}
