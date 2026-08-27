#!/usr/bin/env bash
# End-to-end test on a fresh machine: builds a container with pi, Claude Code
# and Codex installed as an unprivileged user, installs the guard there with
# install.py, and has each harness try to write a *.human.md file against a
# local OpenAI/Anthropic-compatible model. See inside.sh for what is checked.
#
# Usage:
#   e2e/run.sh                                  # defaults below
#   LLM_MODEL=qwen3.6-35b-a3b LLM_BASE_URL=http://127.0.0.1:8080 e2e/run.sh
#   HARNESSES="pi codex" e2e/run.sh             # subset
#
# The container shares the host network so 127.0.0.1 reaches a model server
# running on the host (llama.cpp, llama-swap, vLLM, Ollama with an Anthropic-
# compatible endpoint for Claude Code). No sudo is used at any point.
set -eu -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_SRC="$(dirname "$HERE")"
LLM_BASE_URL="${LLM_BASE_URL:-http://127.0.0.1:8080}"
LLM_MODEL="${LLM_MODEL:-qwen3.6-35b-a3b}"
HARNESSES="${HARNESSES:-pi claude codex}"
IMAGE="${IMAGE:-human-md-guard-e2e}"
OUT="${OUT:-$HERE/out}"

echo "==> building $IMAGE"
docker build -q -t "$IMAGE" "$HERE" >/dev/null

mkdir -p "$OUT"
echo "==> running (model $LLM_MODEL at $LLM_BASE_URL; transcripts -> $OUT)"
docker run --rm --network host \
    -v "$GUARD_SRC:/home/node/human-md-guard:ro" \
    -v "$OUT:/home/node/e2e-out" \
    -e LLM_BASE_URL="$LLM_BASE_URL" -e LLM_MODEL="$LLM_MODEL" -e HARNESSES="$HARNESSES" \
    -e GUARD_DIR=/home/node/human-md-guard -e OUT=/home/node/e2e-out \
    "$IMAGE" bash /home/node/human-md-guard/e2e/inside.sh
