/** Lowercase hex of SHA-256(runId), first `chars` (default 40): the server's `wardby.io/run-sha256` label. */
export async function runSha(runId: string, chars = 40): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(runId));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, chars);
}
