/**
 * The Docker launcher's coding preflight (`wardby coding preflight` with
 * JOB_LAUNCHER=docker), shared with the quickstart's coding step: the worker
 * image must be immutable and present in the local Docker daemon.
 */
import { isImmutableDockerImage } from "../providers/jobs/docker-isolation.js";

/** null when the preflight passes; otherwise the failure, as one sentence. */
export async function dockerCodingPreflight(
  container: { workerImage?: string; proxyContainer?: string },
  inspectImage: (image: string) => Promise<boolean>,
): Promise<string | null> {
  if (!container.workerImage || !container.proxyContainer) {
    return "CODING_WORKER_IMAGE and CODING_PROXY_CONTAINER are required when JOB_LAUNCHER=docker.";
  }
  if (!isImmutableDockerImage(container.workerImage)) {
    return "CODING_WORKER_IMAGE must use an immutable repository digest or local image ID.";
  }
  if (!(await inspectImage(container.workerImage))) {
    return `Docker cannot inspect coding worker image "${container.workerImage}".`;
  }
  return null;
}
