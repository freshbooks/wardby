/** The read model behind GET /admin/api/infra (docs/viewer-api.md): built once at startup, no cluster reads. */
import { loadKubernetesJobConfig, loadProviderConfig } from "../config/providers.js";
import {
  RUN_COMPONENT_LABEL,
  RUN_MANAGED_BY_LABEL,
  RUN_SHA_CHARS,
  RUN_SHA_LABEL,
} from "../providers/jobs/kubernetes-isolation.js";
import type { InfraInfo } from "./api-schema.js";

export function buildInfraInfo(env: NodeJS.ProcessEnv = process.env): InfraInfo {
  const launcher = loadProviderConfig(env).jobs;
  if (launcher !== "kubernetes") return { launcher, kubernetes: null };
  const k8s = loadKubernetesJobConfig(env);
  return {
    launcher,
    kubernetes: {
      namespace: k8s.namespace,
      platform: k8s.platform,
      runtimeClass: k8s.runtimeClassName ?? null,
      proxyService: k8s.proxyService,
      runLabel: RUN_SHA_LABEL,
      runLabelHashChars: RUN_SHA_CHARS,
      componentLabel: { ...RUN_COMPONENT_LABEL },
      managedByLabel: { ...RUN_MANAGED_BY_LABEL },
    },
  };
}
