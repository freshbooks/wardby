/**
 * The coding step's images: the wardby runtime (coding proxy) plus the chosen
 * provider's own images -- the Codex worker, or Claude Code's worker and tool
 * runner. Pulled by digest from a release, or built from a source checkout
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
  /** The Codex worker; only for codex. */
  worker?: string;
  /** Claude Code's worker and tool runner; only for claude-code. */
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

/** Only the chosen provider's images: a Claude-only setup never builds or pulls the Codex worker. */
export function prepareImages(
  provider: CodingProvider,
  config: Record<string, string>,
  deps: CodingDeps,
): PreparedImages {
  const resolved = resolveQuickstartImages({ env: deps.env, packageRoot: deps.packageRoot });
  if ("unavailable" in resolved) throw new CodingSkip(resolved.unavailable);
  if (resolved.source === "build") {
    build(deps, "deploy/Dockerfile", resolved.runtime, "runtime");
    if (provider !== "claude-code") {
      build(deps, "src/coding-worker/Dockerfile", resolved.worker);
      return { runtime: resolved.runtime, worker: imageId(deps, resolved.worker) };
    }
    const claudeWorker = resolved.claudeWorker ?? "wardby-claude-coding-worker:local";
    const claudeToolRunner = resolved.claudeToolRunner ?? "wardby-claude-tool-runner:local";
    build(deps, "src/claude-coding-worker/Dockerfile", claudeWorker);
    build(deps, "src/claude-tool-runner/Dockerfile", claudeToolRunner);
    return {
      runtime: resolved.runtime,
      claudeWorker: imageId(deps, claudeWorker),
      claudeToolRunner: imageId(deps, claudeToolRunner),
    };
  }
  let images: PreparedImages;
  if (provider !== "claude-code") {
    if (!isImmutableDockerImage(resolved.worker)) {
      throw new CodingSkip("CODING_WORKER_IMAGE must be an immutable digest (repo@sha256:...) or local image id");
    }
    images = { runtime: resolved.runtime, worker: resolved.worker };
  } else {
    const claudeWorker = resolved.claudeWorker || config.CODING_CLAUDE_WORKER_IMAGE;
    const claudeToolRunner = resolved.claudeToolRunner || config.CODING_CLAUDE_TOOL_RUNNER_IMAGE;
    if (!claudeWorker || !claudeToolRunner) {
      throw new CodingSkip(
        "Claude Code images aren't available: set both CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE, upgrade to a release that publishes them, or run from a wardby source checkout",
      );
    }
    if (!isImmutableDockerImage(claudeWorker) || !isImmutableDockerImage(claudeToolRunner)) {
      throw new CodingSkip(
        "CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE must be immutable digests (repo@sha256:...) or local image ids",
      );
    }
    images = { runtime: resolved.runtime, claudeWorker, claudeToolRunner };
  }
  for (const image of [images.runtime, images.worker, images.claudeWorker, images.claudeToolRunner]) {
    if (image) pullOrPresent(deps, image);
  }
  return images;
}
