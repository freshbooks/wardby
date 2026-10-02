/**
 * Display-only observation of coding-run service start-up (docs/coding-services.md): launchers
 * report each service's state as they see it, for the viewer. Never part of the launch's own
 * control flow: a reporter error is swallowed. The launcher does await each report inline,
 * though, so a reporter must be fast.
 */

export type ServiceState = "pending" | "probing" | "ready" | "failed";

/** Fixed identifiers only: never probe output, container logs, or anything from the repository. */
export type ServiceFailureReason = "image_unavailable" | "start_failed" | "exited" | "probe_failed" | "timed_out";

export interface ServiceStateUpdate {
  runId: string;
  /** The catalog service name (CodingService.name). */
  name: string;
  state: ServiceState;
  /** Readiness probes completed so far; only launchers that run the probe themselves (Docker) know it. */
  attempts?: number;
  /** Set only with state "failed". */
  reason?: ServiceFailureReason;
}

export type ServiceStateReporter = (update: ServiceStateUpdate) => Promise<void>;

/** Calls `reporter` if there is one; any error it throws is dropped (status is display-only). */
export async function reportServiceState(
  reporter: ServiceStateReporter | undefined,
  update: ServiceStateUpdate,
): Promise<void> {
  if (!reporter) return;
  try {
    await reporter(update);
  } catch {
    // Display-only: a lost update must never fail or slow a launch.
  }
}
