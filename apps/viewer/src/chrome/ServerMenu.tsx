import { useRef } from "react";

interface Props {
  /** Signing out only makes sense while signed in. */
  signedIn: boolean;
  onSignOut: () => void;
  onRemove: () => void;
}

/** Per-server actions: sign out (forget this device's grant) and remove the server. */
export function ServerMenu({ signedIn, onSignOut, onRemove }: Props) {
  const ref = useRef<HTMLDetailsElement>(null);
  const run = (action: () => void) => () => {
    ref.current?.removeAttribute("open");
    action();
  };
  return (
    <details className="server-menu" ref={ref}>
      <summary aria-label="Server menu">⋯</summary>
      <div className="popover">
        {signedIn && (
          <button type="button" onClick={run(onSignOut)}>
            Sign out
          </button>
        )}
        <button type="button" onClick={run(onRemove)}>
          Remove server…
        </button>
      </div>
    </details>
  );
}
