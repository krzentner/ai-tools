#!/usr/bin/env python3
"""Tiny protocol shim so Claude Code and Codex can drive a local model.

llama.cpp (and llama-swap) serve both the Anthropic Messages API that Claude
Code speaks and the OpenAI Responses API that Codex speaks, but both clients
send one thing most open chat templates reject: a system-level message that is
not the first message. Qwen's template raises "System message must be at the
beginning" and the server answers 500.

  - Claude Code puts mid-conversation turns with `role: "system"` in
    `messages` (its agent-types listing, for one).
  - Codex sends `instructions` (which becomes the system prompt) and then an
    `input` item with `role: "developer"`, which becomes a second one.

This proxy rewrites those turns into `user` turns, merging each into an
adjacent user message, and forwards everything else untouched - streaming
responses included. Only the e2e test uses it.

Usage:
    local-model-shim.py LISTEN_PORT UPSTREAM_BASE_URL
    ANTHROPIC_BASE_URL=http://127.0.0.1:LISTEN_PORT claude ...
    # or a Codex model_providers.* entry with base_url http://127.0.0.1:LISTEN_PORT/v1
"""

import http.server
import json
import sys
import urllib.error
import urllib.request

LISTEN_PORT = int(sys.argv[1])
UPSTREAM = sys.argv[2].rstrip("/")

# Roles that a chat template treats as "system" and only allows first.
SYSTEM_ROLES = {"system", "developer"}


def as_blocks(content):
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return list(content)


def demote_system_turns(items: list, is_message) -> list:
    """Turn system-level turns into user turns, merged with an adjacent user turn."""
    out = []
    for item in items:
        if not (is_message(item) and item.get("role") in SYSTEM_ROLES):
            out.append(item)
            continue
        blocks = as_blocks(item.get("content", ""))
        if out and is_message(out[-1]) and out[-1].get("role") == "user":
            merged = dict(out[-1])
            merged["content"] = as_blocks(out[-1].get("content", "")) + blocks
            out[-1] = merged
        else:
            demoted = dict(item)
            demoted["role"] = "user"
            demoted["content"] = blocks
            out.append(demoted)
    return out


def rewrite(path: str, body: dict) -> dict:
    if path.startswith("/v1/messages"):
        body["messages"] = demote_system_turns(body.get("messages", []), lambda m: isinstance(m, dict))
    elif path.startswith("/v1/responses") and isinstance(body.get("input"), list):
        body["input"] = demote_system_turns(
            body["input"], lambda i: isinstance(i, dict) and i.get("type", "message") == "message"
        )
    return body


class Handler(http.server.BaseHTTPRequestHandler):
    def _forward(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if raw:
            try:
                raw = json.dumps(rewrite(self.path, json.loads(raw))).encode()
            except ValueError:
                pass
        req = urllib.request.Request(UPSTREAM + self.path, data=raw or None, method=self.command)
        for key, value in self.headers.items():
            if key.lower() not in ("host", "content-length", "connection", "accept-encoding"):
                req.add_header(key, value)
        try:
            resp = urllib.request.urlopen(req, timeout=900)
            status = resp.status
        except urllib.error.HTTPError as err:
            resp, status = err, err.code
        self.send_response(status)
        for key, value in resp.headers.items():
            if key.lower() in ("content-type", "cache-control"):
                self.send_header(key, value)
        self.send_header("Connection", "close")
        self.end_headers()
        # Stream through unbuffered so SSE events reach the client as produced.
        while True:
            chunk = resp.read(1024)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()

    do_POST = _forward
    do_GET = _forward

    def log_message(self, fmt, *args):
        sys.stderr.write("shim: %s %s\n" % (self.command, self.path))


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), Handler).serve_forever()
