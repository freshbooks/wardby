/** What was clicked besides the run itself: its trigger, or one of its outcomes (by index). */
export type RunFocus = { kind: "trigger" } | { kind: "outcome"; index: number };

/**
 * The run a graph node belongs to, and the item to highlight in its detail panel:
 * `r:<run>` is the run, `t:<run>` the trigger that started it, `o:<run>:<i>` its i-th outcome.
 */
export function selectionForNode(nodeId: string): { runId: string; focus: RunFocus | null } | null {
  const [kind, runId, index] = nodeId.split(":");
  if (!runId) return null;
  switch (kind) {
    case "r":
      return { runId, focus: null };
    case "t":
      return { runId, focus: { kind: "trigger" } };
    case "o": {
      const i = Number(index);
      return Number.isInteger(i) && i >= 0 ? { runId, focus: { kind: "outcome", index: i } } : null;
    }
    default:
      return null;
  }
}
