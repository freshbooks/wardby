import { useState } from "react";
import { cancelSignIn, isAppError, listServers, signIn, type AppError, type ServerSummary } from "../api/client";
import { ErrorLine } from "./ErrorLine";

interface Props {
  server: { name: string; url: string };
  /** Reports the re-read server list and whether `signIn` itself resolved successfully. */
  onChecked: (servers: ServerSummary[] | null, ok: boolean) => void;
  message?: string;
}

export function SignInGate({ server, onChecked, message }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    let ok = false;
    try {
      await signIn(server.url);
      ok = true;
    } catch (e) {
      if (!isAppError(e) || e.kind !== "cancelled")
        setError(isAppError(e) ? e : { kind: "protocol", message: String(e) });
    }
    // A cancel can race a completing sign-in: trust the stored state, not the outcome.
    const servers = await listServers().catch(() => null);
    setBusy(false);
    onChecked(servers, ok);
  }

  return (
    <section className="gate" aria-live="polite">
      <h2>Sign in to {server.name}</h2>
      <p>{message ?? "Your browser opens to finish signing in. This app never sees your password or tokens."}</p>
      {error && <ErrorLine error={error} />}
      <div className="gate-actions">
        <button type="button" className="primary" onClick={() => void start()} disabled={busy}>
          {busy ? "Waiting for browser…" : "Sign in"}
        </button>
        {busy && (
          <button type="button" onClick={() => void cancelSignIn(server.url).catch(() => undefined)}>
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}
