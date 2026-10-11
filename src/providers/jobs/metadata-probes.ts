/**
 * Cloud metadata endpoints a coding or native worker pod must never reach: they hand out node or
 * workload credentials. The instance metadata service (GCE, EC2 IPv4), the EKS Pod Identity agent,
 * and EC2's IPv6 IMDS endpoint. Probed on port 80, where every one of them serves. A pod without
 * IPv6 fails the last connect immediately, which counts as unreachable — correct either way.
 * src/sandbox/fetch-policy.ts blocks the same addresses for in-process fetches.
 */
export const CLOUD_METADATA_PROBES: readonly { host: string; port: number }[] = Object.freeze([
  Object.freeze({ host: "169.254.169.254", port: 80 }),
  Object.freeze({ host: "169.254.170.23", port: 80 }),
  Object.freeze({ host: "fd00:ec2::254", port: 80 }),
]);
