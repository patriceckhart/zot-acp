# zot-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction))
adapter for the [zot](https://www.zot.sh) coding agent.

`zot-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client
(e.g. the Zed editor) and spawns `zot rpc`, bridging requests/events between
the two.

## Status

MVP. Some ACP features may not be implemented yet (see
[Limitations](#limitations)). Development is centred on Zed, other clients may
have varying levels of compatibility.

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Maps zot tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced when available (clients like Zed can
    open the referenced file)
  - Relative file paths are resolved against the session cwd
  - For `edit`, `zot-acp` infers a 1-based line number from a unique `oldText`
    match in the pre-edit file snapshot
  - For `edit`, `zot-acp` snapshots the file before the tool runs and emits an
    ACP **structured diff** (`oldText`/`newText`) on completion
- Session persistence owned by the adapter
  - `zot rpc` disables session files by default
  - The adapter writes a JSONL transcript under
    `$ZOT_HOME/zot-acp/sessions/<sessionId>.jsonl` and remembers the mapping in
    `$ZOT_HOME/zot-acp/session-map.json`
  - `session/load` rehydrates the ACP client by replaying this transcript;
    the model itself starts with an empty context because zot RPC does not
    yet support reattaching to a prior session file
- Slash commands
  - Loads file-based prompt templates from `$ZOT_HOME/prompts/` and
    `<cwd>/.zot/prompts/`
  - Discovers `SKILL.md` files under `$ZOT_HOME/skills/` and
    `<cwd>/.zot/skills/`, surfaces them as `/skill:<name>`
  - Built-in commands: `/compact`, `/session`, `/name`, `/export`, `/clear`
- Best-effort startup info block (zot version + provider/model, context,
  skills, prompts, extensions) emitted on `session/new`

## Prerequisites

Install zot first:

```bash
curl -fsSL https://www.zot.sh/install.sh | bash
```

- Node.js 20+
- `zot` installed and available on your `$PATH`
- zot configured with credentials for your model provider (run `zot` once and
  use `/login`)

## Install

### Add `zot-acp` to your ACP client

#### Using ACP Registry (Zed and other clients that support it)

In Zed, launch the registry with `zed: acp registry` and select `zot ACP`.
Zed maintains the agent server configuration in your `settings.json`:

```json
"agent_servers": {
  "zot-acp": {
    "type": "registry"
  }
}
```

#### Using `npx` (no global install needed)

Add to your Zed `settings.json`:

```json
"agent_servers": {
  "zot": {
    "type": "custom",
    "command": "npx",
    "args": ["-y", "zot-acp"],
    "env": {}
  }
}
```

#### Global install

```bash
npm install -g zot-acp
```

```json
"agent_servers": {
  "zot": {
    "type": "custom",
    "command": "zot-acp",
    "args": [],
    "env": {}
  }
}
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
"agent_servers": {
  "zot": {
    "type": "custom",
    "command": "node",
    "args": ["/path/to/zot-acp/dist/index.js"],
    "env": {}
  }
}
```

### Environment variables

- `ZOT_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises ACP
  `promptCapabilities.embeddedContext` support to the client. Default: off.
  When disabled, compliant ACP clients should avoid sending embedded
  `resource` blocks; if they send them anyway, `zot-acp` degrades gracefully
  by converting them into plain-text prompt context.
- `ZOT_ACP_ZOT_COMMAND` overrides the `zot` executable lookup
  (default: `zot` on Unix, `zot.exe` on Windows).
- `ZOT_ACP_PROVIDER` forwards as `--provider <value>` to `zot rpc`.
- `ZOT_ACP_MODEL` forwards as `--model <value>` to `zot rpc`.
- `ZOT_HOME` honours zot's own configuration directory variable.
- `ZOTCORE_RPC_TOKEN`, if set, is forwarded as the `hello` token to `zot rpc`.

### Slash commands

#### 1) File-based commands (prompt templates)

Loaded from:

- User commands: `$ZOT_HOME/prompts/**/*.md`
- Project commands: `<cwd>/.zot/prompts/**/*.md`

`$ZOT_HOME` defaults to the platform-appropriate location documented in zot's
README.

#### 2) Built-in commands

- `/compact` — summarise the current transcript into one synthetic user
  message (maps to zot's `compact` RPC command)
- `/session` — show session stats (provider, model, message count, token
  usage, cost) from zot's `get_state`
- `/name <name>` — set the adapter-local display name for the session (stored
  in `session-map.json`)
- `/export` — render the local JSONL transcript to HTML in the session cwd
- `/clear` — drop the entire transcript (maps to zot's `clear` RPC command)

#### 3) Skill commands

`SKILL.md` files under `$ZOT_HOME/skills/` and `<cwd>/.zot/skills/` are exposed
as `/skill:<name>`. Invoking one submits the skill body as the next prompt.

## Authentication (ACP Registry support)

This agent supports **Terminal Auth** for the
[ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this shows an **Authenticate** banner that launches zot in a terminal:

```bash
zot-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's
advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run lint
npm run smoke      # spawn the built adapter and drive a minimal handshake
```

Project layout:

- `src/acp/*` — ACP server + translation layer
- `src/zot-rpc/*` — zot subprocess wrapper (RPC protocol)

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation
  (`terminal/*`). zot reads/writes and executes locally.
- MCP servers are accepted in ACP params and stored in session state, but
  zot itself does not currently support MCP, so they are not wired through.
- Assistant streaming is sent as `agent_message_chunk` (no separate thought
  stream — zot does not yet emit thinking deltas over RPC).
- Queue is implemented client-side and behaves like a strict
  "one-at-a-time" queue.
- `session/load` rehydrates the UI from the adapter's local JSONL transcript;
  the underlying `zot rpc` model context starts empty because zot RPC has no
  session-reload command.

## License

MIT
