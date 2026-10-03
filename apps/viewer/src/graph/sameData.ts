import type { NodeProps } from "@xyflow/react";
import type { FlowNodeData } from "./build";

/**
 * memo comparator for custom nodes: React Flow hands every node a fresh `data`
 * object on each graph rebuild, but a node only needs to re-render when the
 * underlying run/trigger/outcome (or selection) actually changed.
 */
export function sameNodeProps(a: NodeProps, b: NodeProps): boolean {
  const x = a.data as unknown as FlowNodeData;
  const y = b.data as unknown as FlowNodeData;
  if (x.kind !== y.kind) return false;
  switch (x.kind) {
    case "run":
      return x.run === (y as typeof x).run && x.selected === (y as typeof x).selected;
    case "trigger":
      return x.trigger === (y as typeof x).trigger && x.label === (y as typeof x).label;
    case "outcome":
      return x.outcome === (y as typeof x).outcome;
  }
}
