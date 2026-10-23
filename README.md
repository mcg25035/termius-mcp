# @c0dingbear/termius-mcp

An **MCP server** that lets agents connect to the machines saved in your
[Termius](https://termius.com) vault — safely.

- **Native GUI approval**: every connection pops a dialog on your computer
  (Allow / Allow-for-session / Deny), via
  [`@c0dingbear/access-prompt`](https://www.npmjs.com/package/@c0dingbear/access-prompt).
  "Allow for this session" mints a `consentToken` so the agent can reconnect to
  that machine without re-prompting until the computer restarts.
- **Token-authorized SSH tunnels** (forward / reverse), through jump-host chains.
- **Exec**: one-shot (`termius_tunnel_exec`, with automatic PTY fallback) and a
  persistent interactive shell (`termius_session_exec`).
- **Background tasks**: start / check / kill long-running commands.
- **SFTP**: `termius_sftp_write` (plain-text only), `read`, `upload`, `download`,
  `list` — so agents stop smuggling files through base64 echoes.
- **Resilient**: keepalive on connections, and dropped tunnels are marked dead
  with a clear message telling the agent to reconnect (instead of a bare
  "Not connected").

Host discovery/decryption comes from
[`@c0dingbear/termius-vault`](https://www.npmjs.com/package/@c0dingbear/termius-vault).

## Install & configure

```bash
npm install -g @c0dingbear/termius-mcp
termius-mcp setup        # detect your agents and add the MCP config
```

`termius-mcp setup` finds installed agents — **opencode, Claude Code, Claude
Desktop, Cursor, Pi** — and offers to add the server to each (merges into the
existing config, backs it up first, and is idempotent). Flags: `--yes`
(non-interactive), `--print` (just show the manual snippet).

On a **global** install the installer also runs this automatically **if** it's
interactive; it **auto-skips after 10 seconds** and never edits a config
without an explicit "yes". Non-interactive/CI installs just print a hint. So the
two things you need are always: **the package installed `&&` your agent
configured** (the `setup` step does the second).

Running the server directly (what the agent launches):

```bash
termius-mcp              # speaks MCP over stdio
```

### Manual MCP client config

```json
{
  "mcp": {
    "termius": {
      "type": "local",
      "command": ["termius-mcp"],
      "environment": { "DISPLAY": ":0" }
    }
  }
}
```

`DISPLAY` (Linux) must point at your desktop session so the approval dialog can
appear. Requires the Termius desktop app installed and logged in.

## License

MIT
