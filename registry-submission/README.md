# Registry submission

Submit to [github.com/agentclientprotocol/registry](https://github.com/agentclientprotocol/registry)
once `zot-acp` is published on npm.

## Steps

1. Publish to npm: `npm publish` (after bumping `package.json` version).
2. Update `agent.json` here with the published version, e.g. `zot-acp@0.1.0`.
3. Fork `agentclientprotocol/registry`.
4. Copy the contents of `zot-acp/` (this directory) into the registry repo as `zot-acp/`.
5. Open a PR.

Zed picks up the icon automatically from the registry once the PR merges and the
CDN refreshes. Existing Zed installs see the new agent on next launch.
