import { CLUSTER_KINDS, type ClusterFrame, type ClusterKind, type ClusterState } from "./types";

const emptyObjects = (): ClusterState["objects"] =>
  Object.fromEntries(CLUSTER_KINDS.map((k) => [k, new Map()])) as ClusterState["objects"];

export const initialCluster: ClusterState = {
  connected: false,
  error: null,
  objects: emptyObjects(),
  kindErrors: {},
  podsSynced: false,
};

const KINDS = new Set<string>(CLUSTER_KINDS);
const isKind = (k: unknown): k is ClusterKind => typeof k === "string" && KINDS.has(k);
const hasName = (v: unknown): v is { name: string } =>
  typeof v === "object" && v !== null && typeof (v as { name?: unknown }).name === "string";

function withKind(state: ClusterState, kind: ClusterKind, map: Map<string, unknown>): ClusterState {
  return { ...state, objects: { ...state.objects, [kind]: map } };
}

/** A frame for `kind` arrived, so its watch is flowing again: drop its error. */
function recovered(state: ClusterState, kind: ClusterKind): ClusterState {
  if (!(kind in state.kindErrors)) return state;
  const kindErrors = { ...state.kindErrors };
  delete kindErrors[kind];
  return { ...state, kindErrors };
}

/** Pure reducer over cluster frames; malformed frames return `state` unchanged. */
export function reduceCluster(state: ClusterState, frame: ClusterFrame): ClusterState {
  if (typeof frame !== "object" || frame === null) return state;
  switch (frame.type) {
    case "status":
      if (typeof frame.connected !== "boolean") return state;
      // A fresh connection starts from nothing: frames of an older one must not linger.
      if (frame.connected) return { ...initialCluster, objects: emptyObjects(), connected: true, error: null };
      return { ...state, connected: false, error: frame.error ?? null };
    case "snapshot": {
      if (!isKind(frame.kind) || !Array.isArray(frame.items)) return state;
      const map = new Map<string, unknown>();
      for (const item of frame.items) if (hasName(item)) map.set(item.name, item);
      const next = recovered(state, frame.kind);
      return { ...withKind(next, frame.kind, map), podsSynced: state.podsSynced || frame.kind === "pod" };
    }
    case "applied": {
      if (!isKind(frame.kind) || !hasName(frame.item)) return state;
      const map = new Map<string, unknown>(state.objects[frame.kind]);
      map.set(frame.item.name, frame.item);
      return withKind(recovered(state, frame.kind), frame.kind, map);
    }
    case "deleted": {
      if (!isKind(frame.kind) || typeof frame.name !== "string") return state;
      const next = recovered(state, frame.kind);
      if (!next.objects[frame.kind].has(frame.name)) return next;
      const map = new Map<string, unknown>(next.objects[frame.kind]);
      map.delete(frame.name);
      return withKind(next, frame.kind, map);
    }
    case "kind_error":
      if (!isKind(frame.kind) || typeof frame.error !== "object" || frame.error === null) return state;
      return { ...state, kindErrors: { ...state.kindErrors, [frame.kind]: frame.error } };
    default:
      return state;
  }
}
