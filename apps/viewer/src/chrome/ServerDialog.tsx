import { useState, type FormEvent } from "react";
import { addServer, isAppError, type AppError } from "../api/client";
import { ErrorLine } from "./ErrorLine";
import { useFocusReturn } from "./useFocusReturn";

interface Props {
  /** Called after the server was saved. */
  onAdded: () => void | Promise<void>;
  /** Present when other servers exist, so the dialog can be dismissed. */
  onCancel?: () => void;
}

export function ServerDialog({ onAdded, onCancel }: Props) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  // Focus moves into the dialog (autoFocus) and returns to the opener on close.
  useFocusReturn();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addServer(name.trim(), url.trim(), clientId.trim() || undefined);
      await onAdded();
    } catch (err) {
      setError(isAppError(err) ? err : { kind: "protocol", message: String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-dialog-title"
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === "Escape" && onCancel) {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id="server-dialog-title">Add a wardby server</h2>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          Server URL
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://wardby.example.com"
            required
          />
        </label>
        <label>
          Client ID (optional)
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} />
          <small>Only needed when the server uses an external identity provider.</small>
        </label>
        {error && <ErrorLine error={error} />}
        <div className="dialog-actions">
          {onCancel && (
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="primary" disabled={busy}>
            Add server
          </button>
        </div>
      </form>
    </div>
  );
}
