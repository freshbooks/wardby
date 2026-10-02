// Stream-first data flow: subscribe to frames and open the event stream BEFORE the
// first graph fetch, so nothing that happens between the two is lost; refetch the
// graph on every `resync` and (debounced) when an event references an unknown run.
import { useEffect, useReducer, useRef, useState } from "react";
import { connect, disconnect, fetchGraph, isAppError, onFrame, type AppError, type FramePayload } from "../api/client";
import { initialModel, reduce, type ViewerModel } from "./reducer";

export const REFETCH_DEBOUNCE_MS = 750;

export interface ViewerOptions {
  since: string;
  limit: number;
}

export interface UseViewer {
  model: ViewerModel;
  /** Latest surfaced error (stream ended, connect or fetch failed). */
  error: AppError | null;
  /** The server needs (re)authentication. */
  needsSignIn: boolean;
  /** The account lacks the admin:view role. */
  forbidden: boolean;
  /** The stream dropped and is retrying. */
  reconnecting: boolean;
  /** A graph snapshot has been loaded for the current server. */
  loaded: boolean;
}

interface Meta {
  url: string | null;
  error: AppError | null;
  reconnecting: boolean;
  loaded: boolean;
}

function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  return { kind: "network", message: e instanceof Error ? e.message : String(e) };
}

export function useViewer(serverUrl: string | null, { since, limit }: ViewerOptions): UseViewer {
  const [model, dispatch] = useReducer(reduce, initialModel);
  // Keyed by server so a server switch starts fresh without resetting state in an effect.
  const [meta, setMeta] = useState<Meta>({ url: null, error: null, reconnecting: false, loaded: false });
  const fresh: Meta =
    meta.url === serverUrl ? meta : { url: serverUrl, error: null, reconnecting: false, loaded: false };
  const { error, reconnecting, loaded } = fresh;

  const sinceRef = useRef(since);
  const limitRef = useRef(limit);
  const agentNames = useRef(new Map<string, string>());
  const loadRef = useRef<(() => void) | null>(null);
  const loadedRef = useRef(false);
  const lastFetchAt = useRef(0);

  useEffect(() => {
    sinceRef.current = since;
    limitRef.current = limit;
    // A window change refetches; the first load is driven by the connect effect.
    if (loadedRef.current) loadRef.current?.();
  }, [since, limit]);

  useEffect(() => {
    const names = new Map<string, string>();
    for (const run of model.runs.values()) names.set(run.agentId, run.agentName);
    agentNames.current = names;
  }, [model.runs]);

  useEffect(() => {
    if (!serverUrl) return;
    let active = true;
    let seq = 0;
    let initialRequested = false;
    let unlisten: (() => void) | undefined;

    dispatch({ type: "reset" });
    loadedRef.current = false;
    const patch = (p: Partial<Omit<Meta, "url">>) =>
      setMeta((m) => ({
        ...(m.url === serverUrl ? m : { url: serverUrl, error: null, reconnecting: false, loaded: false }),
        ...p,
      }));
    const setError = (error: AppError | null) => patch({ error });
    const setReconnecting = (reconnecting: boolean) => patch({ reconnecting });

    const load = async () => {
      const mine = ++seq;
      lastFetchAt.current = Date.now();
      try {
        const snapshot = await fetchGraph(serverUrl, sinceRef.current, limitRef.current);
        if (!active || mine !== seq) return;
        loadedRef.current = true;
        patch({ loaded: true, error: null });
        dispatch({ type: "snapshot", snapshot });
      } catch (e) {
        if (active && mine === seq) setError(toAppError(e));
      }
    };
    loadRef.current = () => void load();

    const ensureInitial = () => {
      if (initialRequested) return;
      initialRequested = true;
      void load();
    };

    const handle = ({ server, frame }: FramePayload) => {
      if (!active || server !== serverUrl) return;
      switch (frame.type) {
        case "hello":
          dispatch({ type: "status", connected: frame.connected });
          if (frame.connected) setReconnecting(false);
          if (!loadedRef.current) ensureInitial();
          break;
        case "status":
          dispatch({ type: "status", connected: frame.connected });
          if (frame.connected) setReconnecting(false);
          break;
        case "resync":
          initialRequested = true;
          void load();
          break;
        case "event":
          dispatch({
            type: "event",
            event: frame.data,
            at: Date.now(),
            agentName: (id) => agentNames.current.get(id),
          });
          break;
        case "reconnecting":
          dispatch({ type: "status", connected: false });
          setReconnecting(true);
          break;
        case "ended":
          dispatch({ type: "status", connected: false });
          setReconnecting(false);
          setError(frame.error);
          break;
      }
    };

    void (async () => {
      try {
        const off = await onFrame(handle);
        if (!active) {
          off();
          return;
        }
        unlisten = off;
        await connect(serverUrl);
        if (!active) return;
        ensureInitial();
      } catch (e) {
        if (active) setError(toAppError(e));
      }
    })();

    return () => {
      active = false;
      loadRef.current = null;
      unlisten?.();
      void disconnect().catch(() => undefined);
    };
  }, [serverUrl]);

  // Debounced trailing refetch when an event referenced a run the snapshot lacks.
  useEffect(() => {
    if (!model.needsRefetch) return;
    const wait = Math.max(0, REFETCH_DEBOUNCE_MS - (Date.now() - lastFetchAt.current));
    const timer = setTimeout(() => loadRef.current?.(), wait);
    return () => clearTimeout(timer);
  }, [model.needsRefetch, serverUrl]);

  return {
    model,
    error,
    needsSignIn: error?.kind === "not_signed_in",
    forbidden: error?.kind === "forbidden",
    reconnecting,
    loaded,
  };
}
