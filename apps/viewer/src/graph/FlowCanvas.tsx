import { Background, ControlButton, Controls, ReactFlow, useReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useState } from "react";
import type { GraphRun } from "../api/types";
import type { Filters as UiFilters } from "../state/filters";
import { buildGraph, type FlowGraph } from "./build";
import { outcomeLabel, OutcomeNode } from "./nodes/OutcomeNode";
import { RunNode } from "./nodes/RunNode";
import { TriggerNode } from "./nodes/TriggerNode";
import { nodeSize } from "./sizes";

const nodeTypes = { trigger: TriggerNode, run: RunNode, outcome: OutcomeNode };

type Positions = Map<string, { x: number; y: number }>;

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

/** Newest tree sits at the top-left of the layout: open there at 1:1 rather than fitting every tree. */
export const HOME_VIEWPORT = { x: 24, y: 24, zoom: 1 } as const;

/** Jumps home whenever a new layout lands (node set changed); live data updates never do. */
function HomeViewport({ layoutKey }: { layoutKey: unknown }) {
  const { setViewport } = useReactFlow();
  useEffect(() => {
    void setViewport(HOME_VIEWPORT);
  }, [layoutKey, setViewport]);
  return null;
}

const ZOOM_ICON = { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": true, focusable: false } as const;

function ViewportControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <Controls
      className="viewport-controls"
      orientation="horizontal"
      position="bottom-right"
      showZoom={false}
      showFitView={false}
      showInteractive={false}
    >
      <ControlButton title="Zoom in" aria-label="Zoom in" onClick={() => void zoomIn()}>
        <svg {...ZOOM_ICON}>
          <path d="M7 2v10M2 7h10" />
        </svg>
      </ControlButton>
      <ControlButton title="Zoom out" aria-label="Zoom out" onClick={() => void zoomOut()}>
        <svg {...ZOOM_ICON}>
          <path d="M2 7h10" />
        </svg>
      </ControlButton>
      <ControlButton title="Fit view" aria-label="Fit view" onClick={() => void fitView({ padding: 0.1 })}>
        <svg {...ZOOM_ICON}>
          <path d="M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9" />
        </svg>
      </ControlButton>
    </Controls>
  );
}

interface Props {
  runs: readonly GraphRun[];
  filters: UiFilters;
  selectedId: string | null;
  onSelect: (runId: string | null) => void;
}

export function FlowCanvas({ runs, filters, selectedId, onSelect }: Props) {
  const graph = useMemo(() => buildGraph(runs, filters, selectedId), [runs, filters, selectedId]);

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
        // Sizes are known (sizes.ts), so pass them as already measured: React Flow resets a
        // node's measurement whenever it gets a new node object, and a node updated faster
        // than it re-measures could otherwise stay hidden.
        const size = nodeSize(n.data);
        out.push({
          id: n.id,
          type: n.type,
          position,
          width: size.width,
          height: size.height,
          measured: size,
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
      {/* Remount once when the first nodes arrive. */}
      <ReactFlow
        key={nodes.length > 0 ? "filled" : "empty"}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultViewport={HOME_VIEWPORT}
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
        <ViewportControls />
        <HomeViewport layoutKey={positions} />
      </ReactFlow>
    </div>
  );
}
