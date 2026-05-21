# zot-acp (ACP adapter for zot)

This repository implements an **Agent Client Protocol (ACP)** adapter for the
**zot** coding agent without modifying zot itself.

- ACP side: **JSON-RPC 2.0 over stdio** using `@agentclientprotocol/sdk` (TypeScript)
- zot side: spawn `zot rpc` and communicate via **newline-delimited JSON** over stdio

## Architecture (MVP)

### 1 ACP session ↔ 1 zot subprocess

`zot rpc` serves one cwd / one model / one session per process, so the adapter
maps:

- `session/new` → spawn a dedicated `zot rpc` process
- `session/prompt` → send `{type:"prompt"}` to that process and stream events back as `session/update`
- `session/cancel` → send `{type:"abort"}`
- `session/load` → respawn `zot rpc` and replay the local JSONL transcript to the client

### ACP server wiring

Use `@agentclientprotocol/sdk`:

- `ndJsonStream(input, output)` to speak ACP over stdio
- `new AgentSideConnection((conn) => new ZotAcpAgent(conn, config), stream)`

## Implementation constraints / decisions

- Do **not** implement ACP client-side FS/terminal delegation. zot already
  reads/writes and executes locally.
- Ignore `mcpServers` (accept in params, store in session state). zot has no
  MCP support yet.
- Stream all zot assistant output as ACP `agent_message_chunk`.
- Tool events: map zot `tool_call` / `tool_result` to ACP `tool_call` /
  `tool_call_update` (text content, plus structured diff for the `edit` tool).
- Session persistence is owned by the adapter. zot RPC disables session files
  by default, so we write a parallel JSONL transcript under
  `$ZOT_HOME/zot-acp/sessions/<sessionId>.jsonl` and remember the mapping in
  `$ZOT_HOME/zot-acp/session-map.json`.

## Dev workflow

- Install deps: `npm install`
- Run in dev: `npm run dev`
- Build: `npm run build`
- Smoke test (stdio): `npm run smoke`
- Lint: `npm run lint`
- Format: `npm run format`

## Manual testing notes

Once the adapter runs, it speaks ACP on stdio:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | node dist/index.js
```

For real validation, point a Zed external-agent config at `node dist/index.js`.

## Coding guidelines

- Keep ACP protocol handling in `src/acp/*`.
- Keep zot RPC subprocess logic in `src/zot-rpc/*`.
- Prefer small translation functions (zot event → ACP session/update).
- Be strict about streaming and process cleanup (handle exit, drain
  stdout/stderr, timeouts).
- Avoid producing unnecessary comments. Use comments sparingly to explain
  non-obvious decisions, not to narrate code.
- Avoid using `any` in TypeScript; prefer explicit types and interfaces. Only
  use `any` when absolutely necessary (e.g. for untyped external data).

## Validation

- After making code edits, run formatting before finishing. `npm run format`
  is safe across the worktree; otherwise narrow the formatter to touched files.
- If formatting is skipped or fails, say so explicitly in the final response.

## Source control

- **DO NOT** commit unless explicitly asked.

## Client information

- Primary target ACP client is Zed.

## References

- zot RPC docs: `/Users/pat/Developer/zot/docs/rpc.md`
- zot extensions: `/Users/pat/Developer/zot/docs/extensions.md`
- zot skills: `/Users/pat/Developer/zot/docs/skills.md`
