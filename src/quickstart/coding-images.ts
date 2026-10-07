/**
 * The coding step's images: the wardby runtime (coding proxy) and the coding
 * worker, plus Claude Code's worker and tool runner when that provider is
 * chosen. Pulled by digest from a release, or built from a source checkout
 * and pinned by local image id (the Docker launcher refuses mutable tags).
 */
import { join } from "node:path";

import type { CodingProvider } from "../coding/provider.js";
import { isImmutableDockerImage } from "../providers/jobs/docker-isolation.js";
import type { CodingDeps } from "./coding.js";
import { resolveQuickstartImages } from "./images.js";

/** Stops the optional coding step with a message; the rest of quickstart carries on. */
export class CodingSkip extends Error {}

export interface PreparedImages {
  runtime: string;
  worker: string;
  claudeWorker?: string;
  claudeToolRunner?: string;
}

function imageId(deps: CodingDeps, tag: string): string {
  const inspected = deps.run("docker", ["image", "inspect", "--format", "{{.Id}}", tag]);
  const id = inspected.stdout.trim();
  if (inspected.status !== 0 || !isImmutableDockerImage(id))
    throw new CodingSkip(`could not read the image id of ${tag}`);
  return id;
}

function build(deps: CodingDeps, dockerfile: string, tag: string, target?: string): void {
  deps.log(`Building ${tag} (this can take a few minutes the first time)...`);
  const args = ["build", "--file", join(deps.packageRoot, dockerfile), ...(target ? ["--target", target] : [])];
  const result = deps.run("docker", [...args, "--tag", tag, deps.packageRoot], { inherit: true });
  if (result.status !== 0) throw new CodingSkip(`docker build of ${tag} failed`);
}

/** Pulls `image`; an image that cannot be pulled is fine if Docker already has it (e.g. a local image id). */
function pullOrPresent(deps: CodingDeps, image: string): void {
  if (deps.run("docker", ["pull", image], { inherit: true }).status === 0) return;
  if (deps.run("docker", ["image", "inspect", image]).status === 0) return;
  throw new CodingSkip(`could not pull ${image}`);
}

export function prepareImages(
  provider: CodingProvider,
  config: Record<string, string>,
  deps: CodingDeps,
): PreparedImages {
  const resolved = resolveQuickstartImages({ env: deps.env, packageRoot: deps.packageRoot });
  if ("unavailable" in resolved) throw new CodingSkip(resolved.unavailable);
  if (resolved.source === "build") {
    build(deps, "deploy/Dockerfile", resolved.runtime, "runtime");
    build(deps, "src/coding-worker/Dockerfile", resolved.worker);
    const images: PreparedImages = { runtime: resolved.runtime, worker: imageId(deps, resolved.worker) };
    if (provider === "claude-code") {
      build(deps, "src/claude-coding-worker/Dockerfile", "wardby-claude-coding-worker:local");
      build(deps, "src/claude-tool-runner/Dockerfile", "wardby-claude-tool-runner:local");
      images.claudeWorker = imageId(deps, "wardby-claude-coding-worker:local");
      images.claudeToolRunner = imageId(deps, "wardby-claude-tool-runner:local");
    }
    return images;
  }
  if (!isImmutableDockerImage(resolved.worker)) {
    throw new CodingSkip("CODING_WORKER_IMAGE must be an immutable digest (repo@sha256:...) or local image id");
  }
  const images: PreparedImages = { runtime: resolved.runtime, worker: resolved.worker };
  if (provider === "claude-code") {
    const claudeWorker = deps.env.CODING_CLAUDE_WORKER_IMAGE || config.CODING_CLAUDE_WORKER_IMAGE;
    const claudeToolRunner = deps.env.CODING_CLAUDE_TOOL_RUNNER_IMAGE || config.CODING_CLAUDE_TOOL_RUNNER_IMAGE;
    if (!claudeWorker || !claudeToolRunner) {
      throw new CodingSkip(
        "Claude Code needs CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE, which this version does not publish; choose Codex, set both, or run quickstart from a clone of the wardby repository",
      );
    }
    Object.assign(images, { claudeWorker, claudeToolRunner });
  }
  for (const image of [images.runtime, images.worker, images.claudeWorker, images.claudeToolRunner]) {
    if (image) pullOrPresent(deps, image);
  }
  return images;
}
