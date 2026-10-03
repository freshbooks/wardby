import { openUrl } from "../../api/client";

/** "↗" on a node: opens its pull request or issue in the browser without selecting the node. */
export function NodeLink({ url, label }: { url: string; label: string }) {
  return (
    <button
      type="button"
      className="node-link nodrag nopan"
      aria-label={`Open ${label}`}
      title={`Open ${url}`}
      onClick={(e) => {
        e.stopPropagation();
        void openUrl(url).catch(() => undefined);
      }}
    >
      ↗
    </button>
  );
}
