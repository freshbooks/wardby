import ELK from "elkjs/lib/elk.bundled.js";
import type { FlowGraph, FlowNodeData } from "./build";

type Size = { width: number; height: number };

const elk = new ELK();

export async function layoutGraph(
  graph: FlowGraph,
  sizes: Partial<Record<FlowNodeData["kind"], Size>> = {},
): Promise<Map<string, { x: number; y: number }>> {
  const positions = new Map<string, { x: number; y: number }>();
  if (graph.nodes.length === 0) return positions;

  const sizeOf = (n: FlowGraph["nodes"][number]): Size => {
    const override = sizes[n.type];
    if (override) return override;
    switch (n.data.kind) {
      case "trigger":
        return { width: 180, height: 64 };
      case "run":
        return { width: 240, height: 96 + 22 * n.data.run.services.length };
      case "outcome":
        return { width: 200, height: 56 };
    }
  };

  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "80",
    },
    children: graph.nodes.map((n) => ({ id: n.id, ...sizeOf(n) })),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });

  for (const c of result.children ?? []) positions.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  return positions;
}
