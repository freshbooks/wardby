import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface QuickstartImages {
  runtime: string;
  worker: string;
  /** Claude Code's worker and tool runner; absent when this source does not provide them. */
  claudeWorker?: string;
  claudeToolRunner?: string;
  source: "env" | "package" | "build";
}

const DIGEST_REF = /@sha256:[0-9a-f]{64}$/;

type PackageImages = Pick<QuickstartImages, "runtime" | "worker" | "claudeWorker" | "claudeToolRunner">;

function readPackageImages(packageRoot: string): PackageImages | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "dist", "quickstart-images.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { runtime, worker, claudeWorker, claudeToolRunner } = parsed as Record<string, unknown>;
    if (typeof runtime !== "string" || typeof worker !== "string") return undefined;
    // An image is never resolved by tag: a tag can be repointed after release.
    if (!DIGEST_REF.test(runtime) || !DIGEST_REF.test(worker)) return undefined;
    // The Claude Code images are optional, but both or neither, and pinned when present.
    if (claudeWorker === undefined && claudeToolRunner === undefined) return { runtime, worker };
    if (typeof claudeWorker !== "string" || typeof claudeToolRunner !== "string") return undefined;
    if (!DIGEST_REF.test(claudeWorker) || !DIGEST_REF.test(claudeToolRunner)) return undefined;
    return { runtime, worker, claudeWorker, claudeToolRunner };
  } catch {
    return undefined;
  }
}

/**
 * Where the coding step gets its runtime and worker images: explicit env
 * overrides, the digest-pinned refs written at release time, or a local build
 * from a source checkout.
 */
export function resolveQuickstartImages(opts: {
  env: NodeJS.ProcessEnv;
  packageRoot: string;
}): QuickstartImages | { unavailable: string } {
  const { env, packageRoot } = opts;
  if (env.WARDBY_RUNTIME_IMAGE && env.CODING_WORKER_IMAGE) {
    return {
      runtime: env.WARDBY_RUNTIME_IMAGE,
      worker: env.CODING_WORKER_IMAGE,
      ...(env.CODING_CLAUDE_WORKER_IMAGE && env.CODING_CLAUDE_TOOL_RUNNER_IMAGE
        ? { claudeWorker: env.CODING_CLAUDE_WORKER_IMAGE, claudeToolRunner: env.CODING_CLAUDE_TOOL_RUNNER_IMAGE }
        : {}),
      source: "env",
    };
  }
  const pinned = readPackageImages(packageRoot);
  if (pinned) return { ...pinned, source: "package" };
  if (
    existsSync(join(packageRoot, "deploy", "Dockerfile")) &&
    existsSync(join(packageRoot, "src", "coding-worker", "Dockerfile"))
  ) {
    return {
      runtime: "wardby-runtime:local",
      worker: "wardby-coding-worker:local",
      claudeWorker: "wardby-claude-coding-worker:local",
      claudeToolRunner: "wardby-claude-tool-runner:local",
      source: "build",
    };
  }
  return {
    unavailable:
      "This version of @wardby/cli was published without coding images. Upgrade @wardby/cli, or run quickstart from a clone of the wardby repository.",
  };
}
