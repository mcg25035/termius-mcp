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

## Run

```bash
npm install -g @c0dingbear/termius-mcp
termius-mcp            # speaks MCP over stdio
```

### opencode / MCP client config

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
