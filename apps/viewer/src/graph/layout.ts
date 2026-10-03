import ELK from "elkjs/lib/elk.bundled.js";
import type { FlowGraph, FlowNodeData } from "./build";
import { trayServices } from "./services";
import { OUTCOME_SIZE, RUN_WIDTH, TREE_GAP, TRIGGER_SIZE, runHeight } from "./sizes";

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
        return TRIGGER_SIZE;
      case "run":
        return { width: RUN_WIDTH, height: runHeight(trayServices(n.data.run).length) };
      case "outcome":
        return OUTCOME_SIZE;
    }
  };

  // Connected components (one run tree each), in first-node order: buildGraph emits newest root first.
  const parent = new Map<string, string>(graph.nodes.map((n) => [n.id, n.id]));
  const find = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const e of graph.edges) {
    if (parent.has(e.source) && parent.has(e.target)) parent.set(find(e.source), find(e.target));
  }
  const groups = new Map<string, FlowGraph["nodes"]>();
  for (const n of graph.nodes) {
    const k = find(n.id);
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }

  let offsetY = 0;
  for (const nodes of groups.values()) {
    const ids = new Set(nodes.map((n) => n.id));
    const result = await elk.layout({
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
        "elk.spacing.nodeNode": "40",
        "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      },
      children: nodes.map((n) => ({ id: n.id, ...sizeOf(n) })),
      edges: graph.edges
        .filter((e) => ids.has(e.source) && ids.has(e.target))
        .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    });
    const sizeById = new Map(nodes.map((n) => [n.id, sizeOf(n)]));
    const placed = result.children ?? [];
    const minX = Math.min(...placed.map((c) => c.x ?? 0));
    const minY = Math.min(...placed.map((c) => c.y ?? 0));
    let maxBottom = 0;
    for (const c of placed) {
      const y = offsetY + (c.y ?? 0) - minY;
      positions.set(c.id, { x: (c.x ?? 0) - minX, y });
      maxBottom = Math.max(maxBottom, y + (sizeById.get(c.id)?.height ?? 0));
    }
    offsetY = maxBottom + TREE_GAP;
  }
  return positions;
}
