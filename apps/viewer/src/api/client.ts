// Typed wrappers over the Rust commands. Tokens never reach JavaScript: these
// calls carry server names, URLs, sign-in state and server JSON only.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { GraphSnapshot, RunDetail, ViewerEvent } from "./types";

export const FRAME_EVENT = "viewer://frame";

/** Mirrors the Rust `AppError` serialization. */
export type AppErrorKind =
  | "network"
  | "http"
  | "protocol"
  | "denied"
  | "timeout"
  | "cancelled"
  | "needs_client_id"
  | "keychain"
  | "storage"
  | "not_signed_in"
  | "forbidden";

export interface AppError {
  kind: AppErrorKind;
  message: string;
  status?: number;
}

/** True for the `{ kind, message }` shape commands reject with. */
export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as AppError).kind === "string" &&
    typeof (e as AppError).message === "string"
  );
}

export interface ServerSummary {
  name: string;
  url: string;
  signed_in: boolean;
}

/** Mirrors the Rust `StreamFrame`, tagged by `type`. */
export type StreamFrame =
  | { type: "hello"; connected: boolean }
  | { type: "status"; connected: boolean }
  | { type: "resync" }
  | { type: "event"; kind: string; data: ViewerEvent }
  | { type: "reconnecting"; attempt: number; delay_ms: number }
  | { type: "ended"; error: AppError };

export interface FramePayload {
  server: string;
  frame: StreamFrame;
}

export const listServers = () => invoke<ServerSummary[]>("list_servers");

export const addServer = (name: string, url: string, clientId?: string) =>
  invoke<void>("add_server", { name, url, clientId: clientId ?? null });

export const removeServer = (url: string) => invoke<void>("remove_server", { url });

/** Opens the system browser and resolves once sign-in completes (up to 5 minutes). */
export const signIn = (url: string) => invoke<void>("sign_in", { url });

/** Aborts a pending sign-in for the server (its `signIn` call rejects with kind "cancelled"). */
export const cancelSignIn = (url: string) => invoke<void>("cancel_sign_in", { url });

export const signOut = (url: string) => invoke<void>("sign_out", { url });

/** Starts the live event stream for a server, replacing any previous one. */
export const connect = (url: string) => invoke<void>("connect", { url });

/** Stops the stream only if it belongs to this server (a late call can't kill another's). */
export const disconnect = (url: string) => invoke<void>("disconnect", { url });

export const fetchGraph = (url: string, since: string, limit: number) =>
  invoke<GraphSnapshot>("fetch_graph", { url, since, limit });

export const fetchRun = (url: string, id: string) => invoke<RunDetail>("fetch_run", { url, id });

/** Subscribes to stream frames; resolves to the function that unsubscribes. */
export function onFrame(cb: (payload: FramePayload) => void): Promise<UnlistenFn> {
  return listen<FramePayload>(FRAME_EVENT, (e) => cb(e.payload));
}
