/**
 * The Docker launcher's coding preflight (`wardby coding preflight` with
 * JOB_LAUNCHER=docker), shared with the quickstart's coding step: every
 * configured worker image must be immutable and present in the local Docker
 * daemon. The Codex worker and the Claude Code pair are each optional, but at
 * least one provider's images must be set.
 */
import { isImmutableDockerImage } from "../providers/jobs/docker-isolation.js";

/** The start-up and preflight refusal when neither provider's images are configured (append the launcher). */
export const CODING_WORKER_IMAGES_REQUIRED =
  "CODING_WORKER_IMAGE (Codex) or both CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE (Claude Code) are required";

export interface DockerPreflightImages {
  workerImage?: string;
  claudeWorkerImage?: string;
  claudeToolRunnerImage?: string;
  proxyContainer?: string;
}

/** The configured worker images, paired with the variable each came from. */
export function configuredCodingImages(container: DockerPreflightImages): Array<[name: string, image: string]> {
  const images: Array<[string, string]> = [];
  if (container.workerImage) images.push(["CODING_WORKER_IMAGE", container.workerImage]);
  if (container.claudeWorkerImage) images.push(["CODING_CLAUDE_WORKER_IMAGE", container.claudeWorkerImage]);
  if (container.claudeToolRunnerImage) {
    images.push(["CODING_CLAUDE_TOOL_RUNNER_IMAGE", container.claudeToolRunnerImage]);
  }
  return images;
}

/** null when the preflight passes; otherwise the failure, as one sentence. */
export async function dockerCodingPreflight(
  container: DockerPreflightImages,
  inspectImage: (image: string) => Promise<boolean>,
): Promise<string | null> {
  if (!container.workerImage && !(container.claudeWorkerImage && container.claudeToolRunnerImage)) {
    return `${CODING_WORKER_IMAGES_REQUIRED} when JOB_LAUNCHER=docker.`;
  }
  if (!container.proxyContainer) return "CODING_PROXY_CONTAINER is required when JOB_LAUNCHER=docker.";
  const images = configuredCodingImages(container);
  for (const [name, image] of images) {
    if (!isImmutableDockerImage(image)) return `${name} must use an immutable repository digest or local image ID.`;
  }
  for (const [, image] of images) {
    if (!(await inspectImage(image))) return `Docker cannot inspect coding worker image "${image}".`;
  }
  return null;
}
