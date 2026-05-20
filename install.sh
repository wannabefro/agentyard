#!/usr/bin/env sh
# agentyard installer.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wannabefro/agentyard/main/install.sh | sh
#
# Optional env overrides:
#   AGENTYARD_VERSION=v0.1.3            install a specific tag instead of latest
#   AGENTYARD_INSTALL_DIR=$HOME/.local/bin   override install location
#   AGENTYARD_SKIP_REGISTER=1           don't auto-register with Claude Code

set -e

REPO="wannabefro/agentyard"
INSTALL_DIR="${AGENTYARD_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${AGENTYARD_VERSION:-latest}"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) os="darwin" ;;
  Linux)  os="linux"  ;;
  *) echo "agentyard: unsupported OS: $os" >&2; exit 1 ;;
esac

case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64"   ;;
  *) echo "agentyard: unsupported arch: $arch" >&2; exit 1 ;;
esac

target="${os}-${arch}"
asset="agentyard-${target}"

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

mkdir -p "$INSTALL_DIR"
bin="$INSTALL_DIR/agentyard"

echo "==> downloading $asset"
echo "    from $url"
echo "    to   $bin"
curl -fL --progress-bar "$url" -o "$bin"
chmod +x "$bin"

# Strip the quarantine attribute on macOS so Gatekeeper doesn't prompt the
# user on first run. The binary is ad-hoc signed in CI, which is sufficient
# to run; the quarantine flag adds the "this was downloaded from the
# internet" warning that we don't need for a CLI tool.
if [ "$os" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$bin" 2>/dev/null || true
fi

# PATH check
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    echo "Note: $INSTALL_DIR is not on your PATH."
    echo "      Either add it to your shell rc, or call agentyard via its full path."
    ;;
esac

# Optional MCP registration
if [ "${AGENTYARD_SKIP_REGISTER:-0}" != "1" ] && command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -q "^agentyard[: ]"; then
    echo "==> claude mcp: 'agentyard' already registered, leaving as-is"
  else
    echo "==> registering with Claude Code (user scope)"
    # Use the absolute binary path so the host doesn't depend on PATH at
    # spawn time.
    claude mcp add agentyard -s user -- "$bin"
  fi
elif [ "${AGENTYARD_SKIP_REGISTER:-0}" != "1" ]; then
  echo
  echo "Claude Code CLI not detected. To register manually after installing it:"
  echo "  claude mcp add agentyard -s user -- $bin"
fi

echo
echo "Installed agentyard at $bin"
echo "Restart Claude Code to pick up the new MCP server."
