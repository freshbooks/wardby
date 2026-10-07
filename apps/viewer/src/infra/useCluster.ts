// Infra data flow: read the server's infra facts first, then (only for a Kubernetes
// launcher) subscribe to cluster frames BEFORE asking Rust to start the watch, so no
// frame is missed. Frames are filtered by server; a context change reconnects.
import { useCallback, useEffect, useReducer, useState } from "react";
import {
  fetchInfra,
  isAppError,
  kubeConnect,
  kubeContexts,
  kubeDisconnect,
  onCluster,
  setKubeContext,
  type AppError,
  type ServerSummary,
} from "../api/client";
import type { InfraInfo } from "../api/types";
import { initialCluster, reduceCluster } from "./state";
import { isClusterError, type ClusterError, type ClusterFrame, type ClusterState } from "./types";

type Contexts = { current: string | null; contexts: string[] };

interface Loaded {
  url: string;
  info: InfraInfo | null;
  contexts: Contexts | null;
  /** The contexts lookup has finished (successfully or not). */
  done: boolean;
  error: AppError | ClusterError | null;
}

export interface UseCluster {
  info: InfraInfo | null;
  contexts: Contexts | null;
  context: string | null;
  setContext(c: string): void;
  cluster: ClusterState;
  loading: boolean;
  error: AppError | ClusterError | null;
}

function toError(e: unknown): AppError | ClusterError {
  if (isClusterError(e) || isAppError(e)) return e;
  return { kind: "other", message: e instanceof Error ? e.message : String(e) };
}

type Action = ClusterFrame | { type: "reset" };
const reducer = (s: ClusterState, a: Action): ClusterState =>
  a.type === "reset" ? initialCluster : reduceCluster(s, a);

export function useCluster(server: ServerSummary): UseCluster {
  const url = server.url;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [override, setOverride] = useState<{ url: string; context: string } | null>(null);
  const [connectError, setConnectError] = useState<{ key: string; error: ClusterError } | null>(null);
  const [cluster, dispatch] = useReducer(reducer, initialCluster);

  // Keyed by server so a server switch never shows the previous one's facts.
  const mine = loaded?.url === url ? loaded : null;
  const info = mine?.info ?? null;
  const contexts = mine?.contexts ?? null;
  const kubernetes = info?.launcher === "kubernetes" ? info.kubernetes : null;
  const namespace = kubernetes?.namespace ?? null;
  const context = (override?.url === url ? override.context : null) ?? server.kube_context ?? contexts?.current ?? null;
  const ready = mine?.done === true;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let infoResult: InfraInfo;
      try {
        infoResult = await fetchInfra(url);
      } catch (e) {
        if (!cancelled) setLoaded({ url, info: null, contexts: null, done: true, error: toError(e) });
        return;
      }
      if (cancelled) return;
      if (infoResult.launcher !== "kubernetes") {
        setLoaded({ url, info: infoResult, contexts: null, done: true, error: null });
        return;
      }
      setLoaded({ url, info: infoResult, contexts: null, done: false, error: null });
      try {
        const ctx = await kubeContexts();
        if (!cancelled) setLoaded({ url, info: infoResult, contexts: ctx, done: true, error: null });
      } catch (e) {
        if (!cancelled) setLoaded({ url, info: infoResult, contexts: null, done: true, error: toError(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    if (!ready || !namespace || !context) return;
    const key = `${url}\n${context}\n${namespace}`;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const un = await onCluster((p) => {
        if (!cancelled && p.server === url) dispatch(p.frame);
      });
      if (cancelled) {
        un();
        return;
      }
      unlisten = un;
      dispatch({ type: "reset" });
      try {
        await kubeConnect(url, context, namespace);
        if (!cancelled) setConnectError(null);
      } catch (e) {
        if (!cancelled) setConnectError({ key, error: toError(e) as ClusterError });
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      void kubeDisconnect(url).catch(() => {});
    };
  }, [url, ready, namespace, context]);

  const setContext = useCallback(
    (c: string) => {
      setOverride({ url, context: c });
      void setKubeContext(url, c).catch(() => {});
    },
    [url],
  );

  const key = `${url}\n${context}\n${namespace}`;
  const error = mine?.error ?? (connectError?.key === key ? connectError.error : null);
  return { info, contexts, context, setContext, cluster, loading: !ready, error };
}
