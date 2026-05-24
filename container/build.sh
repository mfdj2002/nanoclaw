#!/bin/bash
# Build the NanoClaw agent container image.
#
# Reads one optional build flag from ../.env:
#   INSTALL_CJK_FONTS=true   — add Chinese/Japanese/Korean fonts (~200MB)
# setup/container.ts reads the same file, so both build paths stay in sync.
# Callers can also override by exporting INSTALL_CJK_FONTS directly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# Derive the image name from the project root so two NanoClaw installs on the
# same host don't overwrite each other's `nanoclaw-agent:latest` tag. Matches
# setup/lib/install-slug.sh + src/install-slug.ts.
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
IMAGE_NAME="$(container_image_base)"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Caller's env takes precedence; fall back to .env.
if [ -z "${INSTALL_CJK_FONTS:-}" ] && [ -f "../.env" ]; then
    INSTALL_CJK_FONTS="$(grep '^INSTALL_CJK_FONTS=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi

BUILD_ARGS=()
if [ "${INSTALL_CJK_FONTS:-false}" = "true" ]; then
    echo "CJK fonts: enabled (adds ~200MB)"
    BUILD_ARGS+=(--build-arg INSTALL_CJK_FONTS=true)
fi

# Build proxy (optional): pass an HTTP proxy into the build so the in-image
# apt/npm/git/GitHub fetches work behind a firewall (e.g. GFW). The build runs in
# Docker's VM, so a host-loopback proxy is rewritten to host.docker.internal (with
# --add-host so it resolves). Set NANOCLAW_BUILD_PROXY or the standard http(s)_proxy.
PROXY="${NANOCLAW_BUILD_PROXY:-${https_proxy:-${http_proxy:-${HTTPS_PROXY:-${HTTP_PROXY:-}}}}}"
if [ -n "$PROXY" ]; then
    PROXY="${PROXY//127.0.0.1/host.docker.internal}"; PROXY="${PROXY//localhost/host.docker.internal}"
    echo "build proxy: $PROXY"
    for k in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY; do BUILD_ARGS+=(--build-arg "$k=$PROXY"); done
    BUILD_ARGS+=(--build-arg no_proxy=localhost,127.0.0.1 --build-arg NO_PROXY=localhost,127.0.0.1)
    BUILD_ARGS+=(--add-host "host.docker.internal:host-gateway")
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build "${BUILD_ARGS[@]}" -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
