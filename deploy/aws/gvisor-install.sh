#!/usr/bin/env bash
#
# Installs gVisor (runsc and containerd-shim-runsc-v1) on an EKS sandbox node at
# boot, from a pinned release whose SHA-512 is checked before anything is
# installed, and writes the runsc config containerd hands the shim.
#
# Runs as a user-data part, after nodeadm has written containerd's config (which
# registers the runsc runtime) and before kubelet starts. On ANY failure it
# masks kubelet.service, so the node never joins the cluster: a sandbox node
# without gVisor must not be offered run pods. The managed node group then
# reports the node as failing to join.
#
# Settings (exported by the user data, set by Terraform):
#   GVISOR_VERSION      release, e.g. 20260921.0
#   GVISOR_SHA512       SHA-512 of gvisor.tar.bz2 for this release and architecture
#   GVISOR_BASE_URL     <base>/<version>/<arch>/gvisor.tar.bz2
#   GVISOR_INSTALL_DIR  default /usr/local/bin (tests override)
#   GVISOR_RUNSC_CONFIG default /etc/containerd/runsc.toml (tests override)

set -euo pipefail

fail() {
  echo "gvisor-install: $*" >&2
  systemctl mask kubelet.service || true
  exit 1
}
trap 'fail "failed at line ${LINENO}"' ERR

[[ -n "${GVISOR_VERSION:-}" && -n "${GVISOR_SHA512:-}" && -n "${GVISOR_BASE_URL:-}" ]] ||
  fail "GVISOR_VERSION, GVISOR_SHA512 and GVISOR_BASE_URL must all be set"

install_dir="${GVISOR_INSTALL_DIR:-/usr/local/bin}"
runsc_config="${GVISOR_RUNSC_CONFIG:-/etc/containerd/runsc.toml}"
url="${GVISOR_BASE_URL%/}/${GVISOR_VERSION}/$(uname -m)/gvisor.tar.bz2"

command -v bzip2 >/dev/null || dnf install -y -q bzip2

work="$(mktemp -d)"
curl --fail --silent --show-error --location --retry 5 --retry-connrefused \
  -o "${work}/gvisor.tar.bz2" "${url}" || fail "download failed: ${url}"
echo "${GVISOR_SHA512}  ${work}/gvisor.tar.bz2" | sha512sum -c - >/dev/null ||
  fail "checksum mismatch for ${url}"

tar -xjf "${work}/gvisor.tar.bz2" -C "${work}" runsc containerd-shim-runsc-v1
install -m 0755 "${work}/runsc" "${work}/containerd-shim-runsc-v1" "${install_dir}/"

# AL2023's kubelet uses the systemd cgroup driver, so pod cgroup parents are
# systemd slices; runsc must be told to treat them that way.
mkdir -p "$(dirname "${runsc_config}")"
cat >"${runsc_config}" <<'EOF'
[runsc_config]
  systemd-cgroup = "true"
EOF

rm -rf "${work}"
echo "gvisor-install: installed gVisor ${GVISOR_VERSION}"
