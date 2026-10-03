import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import type { GraphRun, RunStatus } from "../api/types";
import { statusGroup, type Filters as UiFilters } from "../state/filters";
import { buildGraph, type Filters as BuildFilters, type FlowGraph } from "./build";
import { outcomeLabel, OutcomeNode } from "./nodes/OutcomeNode";
import { RunNode } from "./nodes/RunNode";
import { TriggerNode } from "./nodes/TriggerNode";

const nodeTypes = { trigger: TriggerNode, run: RunNode, outcome: OutcomeNode };

const ALL_STATUSES: RunStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "refused",
  "lost",
  "budget_exhausted",
  "cancelled",
];

type Positions = Map<string, { x: number; y: number }>;

function toBuildFilters(f: UiFilters): BuildFilters {
  const allGroups = [...new Set(ALL_STATUSES.map(statusGroup))].every((g) => f.statuses.has(g));
  return {
    statuses: allGroups ? null : new Set(ALL_STATUSES.filter((s) => f.statuses.has(statusGroup(s)))),
    agentIds: f.agents.size > 0 ? f.agents : null,
    search: f.search,
  };
}

function nodeLabel(d: FlowGraph["nodes"][number]["data"]): string {
  switch (d.kind) {
    case "run":
      return `${d.run.agentName}, ${d.run.status}, run ${d.run.id.slice(-6)}`;
    case "trigger":
      return d.label;
    case "outcome":
      return outcomeLabel(d.outcome).label;
  }
}

/** Fallback when the layout engine fails to load: a plain grid so the view still works. */
function gridPositions(graph: FlowGraph): Positions {
  return new Map(graph.nodes.map((n, i) => [n.id, { x: (i % 4) * 320, y: Math.floor(i / 4) * 140 }]));
}

interface Props {
  runs: readonly GraphRun[];
  filters: UiFilters;
  selectedId: string | null;
  onSelect: (runId: string | null) => void;
}

export function FlowCanvas({ runs, filters, selectedId, onSelect }: Props) {
  const graph = useMemo(() => buildGraph(runs, toBuildFilters(filters), selectedId), [runs, filters, selectedId]);

  // Layout runs only when the set of node/edge ids changes, so live status and
  // cost updates never move nodes. `layoutInput` is the graph as of the last
  // structural change.
  const structureKey = `${graph.nodes.map((n) => n.id).join("|")}#${graph.edges.map((e) => e.id).join("|")}`;
  const [layoutInput, setLayoutInput] = useState({ key: structureKey, graph });
  if (layoutInput.key !== structureKey) setLayoutInput({ key: structureKey, graph });

  const [positions, setPositions] = useState<Positions | null>(null);
  useEffect(() => {
    const g = layoutInput.graph;
    if (g.nodes.length === 0) return;
    // A newer structure (or unmount) cancels this one: out-of-order results are dropped.
    let cancelled = false;
    import("./layout")
      .then((m) => m.layoutGraph(g))
      .catch(() => gridPositions(g))
      .then((p) => {
        if (!cancelled) setPositions(p);
      });
    return () => {
      cancelled = true;
    };
  }, [layoutInput]);

  const nodes = useMemo<Node[]>(() => {
    if (!positions) return [];
    const out: Node[] = [];
    for (const n of graph.nodes) {
      const position = positions.get(n.id);
      if (position) {
        out.push({
          id: n.id,
          type: n.type,
          position,
          ariaLabel: nodeLabel(n.data),
          data: n.data as unknown as Record<string, unknown>,
        });
      }
    }
    return out;
  }, [graph, positions]);

  const edges = useMemo<Edge[]>(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  }, [graph, nodes]);

  if (positions === null && graph.nodes.length > 0) return <p className="muted">Laying out…</p>;

  return (
    // Enter/Space on a focused run node selects it (React Flow only handles click).
    <div
      className="flow-canvas"
      aria-label="Run graph"
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const id = (e.target as HTMLElement).closest?.(".react-flow__node")?.getAttribute("data-id");
        if (id?.startsWith("r:")) {
          e.preventDefault();
          onSelect(id.slice(2));
        }
      }}
    >
      {nodes.length === 0 && <p className="muted flow-empty">No runs in this window.</p>}
      {/* Remount once when the first nodes arrive so fitView frames them. */}
      <ReactFlow
        key={nodes.length > 0 ? "filled" : "empty"}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.2}
        nodesDraggable={false}
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => {
          if (node.id.startsWith("r:")) onSelect(node.id.slice(2));
        }}
        onPaneClick={() => onSelect(null)}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
