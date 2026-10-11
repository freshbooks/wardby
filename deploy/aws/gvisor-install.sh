#!/usr/bin/env bash
#
# Installs gVisor (runsc and containerd-shim-runsc-v1) on an EKS sandbox node at
# boot, from a pinned release whose SHA-512 is checked before anything is
# installed, and writes the runsc config containerd hands the shim.
#
# Runs as a user-data part, after nodeadm has written containerd's config (which
# registers the runsc runtime) and before kubelet starts.
#
# Fail closed: before anything that can fail, it writes a kubelet.service
# drop-in with ConditionPathExists=<marker>, and it creates the marker only as
# the very last step of a fully successful install. Until the marker exists,
# systemd skips every start of kubelet (nodeadm's included, and on every
# reboot), so the node never joins the cluster: a sandbox node without gVisor
# must not be offered run pods. This holds however the install stops -- an
# error, a kill, or a hang. The managed node group then reports the node as
# failing to join. (Masking kubelet would not work: on the EKS AL2023 AMI
# kubelet.service is a regular file in /etc/systemd/system, which
# `systemctl mask` refuses to replace.) Each run removes the marker first, so a
# failed re-run also leaves kubelet gated.
#
# Settings (exported by the user data, set by Terraform):
#   GVISOR_VERSION          release, e.g. 20260921.0
#   GVISOR_SHA512           SHA-512 of gvisor.tar.bz2 for this release and architecture
#   GVISOR_BASE_URL         <base>/<version>/<arch>/gvisor.tar.bz2
#   GVISOR_INSTALL_DIR      default /usr/local/bin (tests override)
#   GVISOR_RUNSC_CONFIG     default /etc/containerd/runsc.toml (tests override)
#   GVISOR_KUBELET_DROPIN   default /etc/systemd/system/kubelet.service.d/00-wardby-gvisor.conf (tests override)
#   GVISOR_INSTALLED_MARKER default /etc/wardby/gvisor-installed (tests override)

set -euo pipefail

fail() {
  echo "gvisor-install: $*" >&2
  exit 1
}
trap 'fail "failed at line ${LINENO}"' ERR

# Gate kubelet on the marker first, so nothing below can leave it ungated.
kubelet_dropin="${GVISOR_KUBELET_DROPIN:-/etc/systemd/system/kubelet.service.d/00-wardby-gvisor.conf}"
marker="${GVISOR_INSTALLED_MARKER:-/etc/wardby/gvisor-installed}"
rm -f "${marker}"
mkdir -p "$(dirname "${kubelet_dropin}")"
printf '[Unit]\nConditionPathExists=%s\n' "${marker}" >"${kubelet_dropin}"
systemctl daemon-reload

[[ -n "${GVISOR_VERSION:-}" && -n "${GVISOR_SHA512:-}" && -n "${GVISOR_BASE_URL:-}" ]] ||
  fail "GVISOR_VERSION, GVISOR_SHA512 and GVISOR_BASE_URL must all be set"

install_dir="${GVISOR_INSTALL_DIR:-/usr/local/bin}"
runsc_config="${GVISOR_RUNSC_CONFIG:-/etc/containerd/runsc.toml}"
url="${GVISOR_BASE_URL%/}/${GVISOR_VERSION}/$(uname -m)/gvisor.tar.bz2"

command -v bzip2 >/dev/null || dnf install -y -q bzip2

work="$(mktemp -d)"
curl --fail --silent --show-error --location --retry 5 --retry-connrefused \
  --connect-timeout 15 --max-time 900 \
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

# Last step: only a fully successful install lets kubelet start.
mkdir -p "$(dirname "${marker}")"
touch "${marker}"
echo "gvisor-install: installed gVisor ${GVISOR_VERSION}"
