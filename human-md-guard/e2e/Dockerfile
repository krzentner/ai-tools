# Fresh "machine" for the end-to-end test: pi, Claude Code and Codex installed
# as an unprivileged user, nothing under the user's control needs sudo. Root is
# used only for the base OS packages every such machine would already have.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git procps python3 \
    && rm -rf /var/lib/apt/lists/*

USER node
ENV HOME=/home/node
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=/home/node/.npm-global/bin:/home/node/.local/bin:$PATH
WORKDIR /home/node

ARG PI_VERSION=latest
ARG CODEX_VERSION=latest
RUN mkdir -p "$NPM_CONFIG_PREFIX" \
    && npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

# Anthropic's installer: home-directory only, refuses to run under sudo.
RUN curl -fsSL https://claude.ai/install.sh | bash

# Sanity: every harness answers --version as this user.
RUN pi --version && codex --version && claude --version
