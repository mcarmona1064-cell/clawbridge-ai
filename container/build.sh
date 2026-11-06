#!/bin/bash
# Build the ClawBridge agent container image.
#
# Usage:
#   build.sh [tag]
#
# Reads optional build flags from ../.env:
#   INSTALL_CJK_FONTS=true   — add Chinese/Japanese/Korean fonts (~200MB)
#   INSTALL_CLAUDE=false     — leave the Claude Code CLI out of the image
#   INSTALL_CODEX=false      — leave the Codex CLI out of the image
# Callers can also override by exporting these vars directly.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

# Derive the image name from the project root so two ClawBridge installs on the
# same host don't overwrite each other's `clawbridge-codex:latest` tag. Matches
# setup/lib/install-slug.sh + src/install-slug.ts.
# shellcheck source=../setup/lib/install-slug.sh
source "$PROJECT_ROOT/setup/lib/install-slug.sh"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

DOCKERFILE="Dockerfile"
IMAGE_BASE="${CONTAINER_IMAGE_BASE:-$(container_image_base)}"
IMAGE_NAME="${IMAGE_BASE}"
TAG="${1:-latest}"

# Caller's env takes precedence; fall back to .env.
if [ -z "${INSTALL_CJK_FONTS:-}" ] && [ -f "../.env" ]; then
    INSTALL_CJK_FONTS="$(grep '^INSTALL_CJK_FONTS=' ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
fi

BUILD_ARGS=()
if [ "${INSTALL_CJK_FONTS:-false}" = "true" ]; then
    echo "CJK fonts: enabled (adds ~200MB)"
    BUILD_ARGS+=(--build-arg INSTALL_CJK_FONTS=true)
fi

# Provider CLIs baked into the image (both on by default).
for flag in INSTALL_CLAUDE INSTALL_CODEX; do
    if [ -z "${!flag:-}" ] && [ -f "../.env" ]; then
        val="$(grep "^${flag}=" ../.env | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
        [ -n "$val" ] && printf -v "$flag" '%s' "$val"
    fi
    if [ -n "${!flag:-}" ]; then
        echo "${flag}=${!flag}"
        BUILD_ARGS+=(--build-arg "${flag}=${!flag}")
    fi
done

echo "Building ClawBridge agent container image..."

echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build "${BUILD_ARGS[@]}" -f "${DOCKERFILE}" -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
