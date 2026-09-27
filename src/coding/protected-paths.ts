/**
 * Protected for every coding run, whatever an agent's own protectedPaths say
 * (docs/coding-services.md): wardby's own configuration under .wardby/, except
 * the service declaration, which any builder may propose in its pull request
 * (it takes effect only after a person merges it, since dispatch reads it from
 * the base branch). Part of DEFAULT_PROTECTED_PATHS so new agents show it, and
 * always added by protectedPathMatcher (providers/vcs/git.ts) so agents created
 * before it existed get it too. An exception always wins, so no agent's list
 * can take the declaration exception away.
 */
export const WARDBY_PROTECTED_PATHS = [".wardby/**", "!.wardby/services.yaml"] as const;

/** A leading "!" makes a protectedPaths entry an exception (providers/vcs/git.ts protectedPathMatcher). */
export const PROTECTED_PATH_EXCEPTION = "!";

export function isProtectedPathException(path: string): boolean {
  return path.startsWith(PROTECTED_PATH_EXCEPTION);
}

/** The glob of a protectedPaths entry: the entry itself, or what follows an exception's leading "!". */
export function protectedPathBody(path: string): string {
  return isProtectedPathException(path) ? path.slice(PROTECTED_PATH_EXCEPTION.length) : path;
}

/**
 * Whether a trimmed protectedPaths entry has a valid shape: a repository-relative
 * POSIX glob with no empty or traversal components, optionally behind one leading
 * "!". Length and control-character bounds are the caller's.
 */
export function isWellFormedProtectedPath(path: string): boolean {
  const body = protectedPathBody(path);
  return (
    body.length > 0 &&
    !isProtectedPathException(body) &&
    !body.startsWith("/") &&
    !body.startsWith("./") &&
    !body.includes("\\") &&
    !body.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

/** Exceptions only carve paths out; a list of nothing but exceptions protects nothing. */
export function protectsSomePath(paths: readonly string[]): boolean {
  return paths.some((path) => !isProtectedPathException(path));
}
