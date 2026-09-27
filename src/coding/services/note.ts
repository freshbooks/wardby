/**
 * The paragraph dispatch adds to a coding agent's standing instructions when
 * its run has services (docs/coding-services.md): which services, the
 * variables each sets, and that they start empty. The worker sees only its task
 * text, so this is how the builder learns the contract.
 */
import type { ResolvedCodingService } from "./catalog.js";

export function servicesInstructionNote(
  services: readonly Pick<ResolvedCodingService, "name" | "version" | "testEnv">[],
): string | undefined {
  if (services.length === 0) return undefined;
  const lines = services.map((service) => {
    const variables = Object.entries(service.testEnv)
      .map(([name, value]) => `${name}=${value}`)
      .join(", ");
    return `- ${service.name} ${service.version}${variables ? `: ${variables}` : ""}`;
  });
  return [
    "Services for this run: wardby started these next to your workspace, reachable on 127.0.0.1. Each one starts empty; create any schema or data your tests need.",
    ...lines,
    "These variables are already set in your shell environment; tests should read them instead of hard-coding connection details. Where two services set the same variable, the one listed first wins.",
  ].join("\n");
}
