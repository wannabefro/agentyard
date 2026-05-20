#!/usr/bin/env bash
# Cross-compile single-file executables for macOS and Linux (arm64 + x64).
# Each binary embeds the Bun runtime, so end users don't need Bun installed.
# Output: dist/agentyard-<os>-<arch>
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p dist

# Default to all four targets; callers (e.g. CI matrix) can pass a subset.
if [[ $# -gt 0 ]]; then
  TARGETS=("$@")
else
  TARGETS=("darwin-arm64" "darwin-x64" "linux-arm64" "linux-x64")
fi

for target in "${TARGETS[@]}"; do
  out="dist/agentyard-${target}"
  echo "==> building ${out}"
  bun build \
    --compile \
    --minify \
    --target="bun-${target}" \
    src/index.ts \
    --outfile "${out}"

  # macOS refuses to run unsigned Mach-O binaries (SIGKILL on launch, no
  # diagnostic). Ad-hoc sign so the binary is at least runnable; users who
  # distribute beyond their own machines may want a Developer ID sign +
  # notarization on top.
  # The remove-signature step is required even on freshly-built binaries:
  # codesign rejects an initial sign with "invalid or unsupported format"
  # until the slot is explicitly cleared.
  if [[ "${target}" == darwin-* ]] && command -v codesign >/dev/null 2>&1; then
    codesign --remove-signature "${out}" >/dev/null 2>&1 || true
    codesign -s - "${out}"
  fi
done

echo
echo "Built:"
ls -lh dist/
