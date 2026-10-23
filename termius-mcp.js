#!/usr/bin/env node
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { 
  CallToolRequestSchema, 
  ListToolsRequestSchema 
} = require("@modelcontextprotocol/sdk/types.js");
const { TermiusClient } = require("@c0dingbear/termius-vault");
const { Client } = require("ssh2");
const net = require("net");
const crypto = require("crypto");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { promptAccess } = require("@c0dingbear/access-prompt");

// Open (and cache) an SFTP session over an active tunnel's SSH connection.
// Reuses the already-authorized connection, so no extra GUI prompt.
function getSftp(tunnel) {
  return new Promise((resolve, reject) => {
    if (tunnel.sftp) return resolve(tunnel.sftp);
    if (!tunnel.sshClient) return reject(new Error("Tunnel has no active SSH connection"));
    tunnel.sshClient.sftp((err, sftp) => {
      if (err) return reject(err);
      tunnel.sftp = sftp;
      sftp.on("close", () => { tunnel.sftp = null; });
      resolve(sftp);
    });
  });
}

// Standard error payload with a helpful, actionable message.
function errResp(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// Resolve a tunnel by id with a clear explanation when it is missing or dead,
// so the agent knows whether to recreate it rather than seeing a bare
// "Not connected".
function getTunnel(tunnelId) {
  const tunnel = activeTunnels.get(tunnelId);
  if (!tunnel) {
    const open = Array.from(activeTunnels.keys());
    return {
      error: errResp(
        `Tunnel "${tunnelId}" not found — it was never created or has been closed. ` +
        (open.length ? `Currently open tunnels: ${open.join(", ")}. ` : `No tunnels are open right now. `) +
        `Call create_tunnel to open one (use list_tunnels to see what's active).`
      )
    };
  }
  if (tunnel.dead) {
    return {
      error: errResp(
        `Tunnel "${tunnelId}" is no longer connected: ${tunnel.deadReason || "the SSH connection dropped"}. ` +
        `SSH sessions can drop after idle time or a network change. Call close_tunnel on it, then create_tunnel again to reconnect.`
      )
    };
  }
  return { tunnel };
}

// Wire a tunnel's SSH connection lifecycle: when it drops after being
// established, mark the tunnel dead (with a reason) and tear down its shell /
// SFTP sessions, instead of leaving a stale entry that throws "Not connected".
function wireTunnelLifecycle(tunnelId, sshClient) {
  if (!sshClient) return;
  const markDead = (why) => {
    const t = activeTunnels.get(tunnelId);
    if (!t || t.dead) return;
    t.dead = true;
    t.deadReason = why;
    try { if (t.shellStream) t.shellStream.close(); } catch {}
    t.shellStream = null;
    try { if (t.sftp) t.sftp.end(); } catch {}
    t.sftp = null;
    console.error(`Tunnel ${tunnelId} marked dead: ${why}`);
  };
  sshClient.on("error", (e) => {
    const t = activeTunnels.get(tunnelId);
    if (t) t.deadReason = `SSH error: ${e.message}`; // close usually follows
  });
  sshClient.on("end", () => markDead("SSH connection ended by the remote host"));
  sshClient.on("close", () => markDead(
    (activeTunnels.get(tunnelId) && activeTunnels.get(tunnelId).deadReason) || "SSH connection closed"
  ));
}

// Run a one-shot command. Try without a PTY first (clean stdout/stderr split);
// if the remote rejects the command for lack of a terminal, retry with a PTY so
// hosts that force a TTY still work.
function sshExec(sshClient, command, done) {
  const attempt = (usePty) => {
    let settled = false;
    sshClient.exec(command, usePty ? { pty: true } : {}, (err, stream) => {
      if (err) { done({ error: err.message }); return; }
      let stdout = "", stderr = "";
      stream.on("data", (d) => { stdout += d.toString(); });
      stream.stderr.on("data", (d) => { stderr += d.toString(); });
      stream.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        if (!usePty && /requires?\s+a[n]?\s*(active\s*)?(pty|tty)|must be run from a (terminal|tty)|no\s+tty/i.test(stdout + stderr)) {
          attempt(true);
          return;
        }
        done({ stdout, stderr, exitCode: code ?? (signal ? -1 : 0), signal: signal || null, usedPty: usePty });
      });
    });
  };
  attempt(false);
}

// Initialize Termius Client
const termius = new TermiusClient();

// In-memory store for active tunnels
const activeTunnels = new Map();
let tunnelCounter = 0;

// Keep one authorization prompt per agent/host. A timed-out MCP request may
// be retried while the original GUI prompt is still waiting for the user.
const pendingAuthorizations = new Map();
const authorizationCooldowns = new Map();
const AUTHORIZATION_COOLDOWN_MS = 30_000;
// How long the user has to answer the GUI dialog before we report "no response".
const AUTHORIZATION_DIALOG_TIMEOUT_S = 120;

// Long-term per-session consent. When the user picks "Allow for this session",
// we mint a consent token scoped to that machine. While this process keeps
// running (i.e. until the machine reboots / the MCP server is restarted), the
// agent may pass that token on later create_tunnel calls to the SAME machine to
// connect without prompting the user again.
const sessionGrants = new Map(); // token -> { targetLabel, agentName, grantedAt }
function grantSessionConsent(targetLabel, agentName) {
  const token = `consent-${crypto.randomBytes(18).toString("hex")}`;
  sessionGrants.set(token, { targetLabel, agentName, grantedAt: Date.now() });
  return token;
}
function consentTokenValidFor(token, targetLabel) {
  if (!token) return false;
  const g = sessionGrants.get(token);
  return !!g && g.targetLabel === targetLabel;
}

// In-memory store for active tasks running in the background
const activeTasks = new Map();
let taskCounter = 0;

// Helper to get or create a persistent shell session
function getOrCreateShell(tunnel) {
  return new Promise((resolve, reject) => {
    if (tunnel.shellStream) {
      resolve(tunnel.shellStream);
      return;
    }

    tunnel.sshClient.shell((err, stream) => {
      if (err) {
        reject(err);
        return;
      }

      tunnel.shellStream = stream;
      tunnel.shellStdout = "";
      tunnel.shellStderr = "";

      stream.on("data", (data) => {
        tunnel.shellStdout += data.toString();
      });

      stream.stderr.on("data", (data) => {
        tunnel.shellStderr += data.toString();
      });

      stream.on("close", () => {
        tunnel.shellStream = null;
        console.error(`Shell stream closed for tunnel ${tunnel.tunnelId}`);
      });

      resolve(stream);
    });
  });
}

// Helper to execute a command sequentially inside the persistent shell session
function sessionExec(tunnel, command, timeoutMs = 30000) {
  const run = async () => {
    const stream = await getOrCreateShell(tunnel);
    
    // Clear previous stdout/stderr to make parsing clean for this command
    tunnel.shellStdout = "";
    tunnel.shellStderr = "";
    
    const delimiter = `__MCP_DELIM_${crypto.randomBytes(8).toString("hex")}__`;
    
    return new Promise((resolve, reject) => {
      let timeout;
      let interval;

      const cleanUp = () => {
        clearTimeout(timeout);
        clearInterval(interval);
      };
      
      const checkOutput = () => {
        const idx = tunnel.shellStdout.indexOf(delimiter);
        if (idx !== -1) {
          cleanUp();
          
          // Command output is everything before the delimiter
          let fullOutput = tunnel.shellStdout.substring(0, idx);
          
          // Parse exit code from the part following the delimiter
          const postDelim = tunnel.shellStdout.substring(idx + delimiter.length);
          const match = postDelim.match(/_EXIT_:(-?\d+)/);
          const exitCode = match ? parseInt(match[1], 10) : 0;
          
          // Keep only what comes after the exit code output in the buffer
          const exitStrMatch = postDelim.match(/_EXIT_:-?\d+\r?\n?/);
          const cutLen = exitStrMatch ? exitStrMatch[0].length : 0;
          tunnel.shellStdout = postDelim.substring(cutLen);
          
          // Clean up the echoed command from stdout if present at the start
          const lines = fullOutput.split(/\r?\n/);
          if (lines.length > 0) {
            if (lines[0].includes(delimiter) || lines[0].includes(command.substring(0, 10))) {
              lines.shift();
            }
            if (lines.length > 0 && lines[0].includes("_EXIT_")) {
              lines.shift();
            }
            fullOutput = lines.join("\n");
          }

          resolve({
            stdout: fullOutput.trim(),
            stderr: tunnel.shellStderr.trim(),
            exitCode
          });
        }
      };

      // Set timeout
      timeout = setTimeout(() => {
        cleanUp();
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Poll the buffer for the delimiter every 50ms
      interval = setInterval(checkOutput, 50);

      // Write command to the stream
      stream.write(`\n${command}; echo "${delimiter}_EXIT_:$?"\n`);
    });
  };

  // Queue/Chain execution using a local promise chain to ensure thread-safety
  const nextLock = (tunnel.shellLock || Promise.resolve())
    .then(run)
    .catch((err) => {
      return { error: err.message };
    });

  tunnel.shellLock = nextLock.then(() => {});
  return nextLock;
}

const server = new Server({
  name: "termius-mcp",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {}
  }
});

// Helper: Generate secure token
function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}

function sshConnectOptions(connection, sock) {
  const options = {
    host: (connection.host || "").trim(),
    port: connection.port || 22,
    username: connection.username,
    readyTimeout: 20000,
    // Keep idle connections alive so the server/NAT doesn't silently drop them,
    // which was the main cause of later "Not connected" failures.
    keepaliveInterval: 15000,
    keepaliveCountMax: 3
  };
  if (sock) options.sock = sock;
  if (connection.authType === "password") options.password = connection.password;
  if (connection.authType === "key") {
    options.privateKey = connection.privateKey;
    if (connection.passphrase) options.passphrase = connection.passphrase;
  }
  return options;
}

function connectSSH(connection, sock) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("error", reject);
    client.once("ready", () => resolve(client));
    client.connect(sshConnectOptions(connection, sock));
  });
}

async function connectThroughChain(target) {
  const clients = [];
  let socket;
  try {
    const path = [];
    const visited = new Set();
    const append = (connection) => {
      if (!connection || visited.has(connection.id)) return;
      visited.add(connection.id);
      for (const jump of connection.connectChain || []) append(jump);
      path.push(connection);
    };
    append(target);
    for (let index = 0; index < path.length; index++) {
      const connection = path[index];
      const client = await connectSSH(connection, socket);
      clients.push(client);
      if (index < path.length - 1) {
        const next = path[index + 1];
        socket = await new Promise((resolve, reject) => {
          client.forwardOut("127.0.0.1", 0, next.host, next.port || 22, (error, stream) => {
            if (error) reject(error);
            else resolve(stream);
          });
        });
      }
    }
    return { client: clients[clients.length - 1], clients };
  } catch (error) {
    clients.forEach(client => client.end());
    if (socket) socket.destroy();
    throw error;
  }
}

// Authorization prompt. Delegates the actual native dialog to the
// cross-platform `access-prompt` layer and keeps the app-level concerns here:
// a short deny-cooldown and de-duping concurrent prompts for the same
// agent+host. Returns one of:
//   "allow" | "allow_session" | "deny" | "no_response" | "unavailable"
function requestGuiAuthorization(agentName, serverName) {
  const key = `${agentName}\0${serverName}`;
  const cooldownUntil = authorizationCooldowns.get(key) || 0;
  if (cooldownUntil > Date.now()) {
    return Promise.resolve({
      decision: "deny",
      reason: `The user recently denied this request. Wait ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s before asking again.`
    });
  }

  const pending = pendingAuthorizations.get(key);
  if (pending) return pending;

  const request = promptAccess({
    agentName,
    serverName,
    timeoutSeconds: AUTHORIZATION_DIALOG_TIMEOUT_S
  }).then((res) => {
    pendingAuthorizations.delete(key);
    if (res.decision === "deny") {
      authorizationCooldowns.set(key, Date.now() + AUTHORIZATION_COOLDOWN_MS);
    }
    if (res.decision === "no_response" && !res.reason) {
      res.reason = `The user did not respond within ${AUTHORIZATION_DIALOG_TIMEOUT_S}s (they may be away from the computer). No choice was made.`;
    }
    return res;
  }).catch((err) => {
    pendingAuthorizations.delete(key);
    return { decision: "unavailable", reason: `Could not show the authorization dialog: ${err.message}` };
  });

  pendingAuthorizations.set(key, request);
  return request;
}

// Tool registration
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_machines",
        description: "List all remote machines and connection profiles stored in Termius.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "create_tunnel",
        description: "Establish a secure, token-authenticated SSH tunnel (forward or reverse) to a remote machine. Pops up a GUI dialog on the host for the user to Allow / Allow-for-session / Deny. On denial the result says the user refused (do not auto-retry); if the dialog times out the result says there was no response (the user may be away). If the user chose 'Allow for this session', the result includes a `consentToken` — pass it back on later create_tunnel calls to the SAME machine to connect without prompting, until this computer restarts.",
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "The host IP or label of the machine in Termius."
            },
            type: {
              type: "string",
              enum: ["forward", "reverse"],
              description: "Tunnel type: 'forward' (local port maps to remote port) or 'reverse' (remote port maps back to local port)."
            },
            localPort: {
              type: "number",
              description: "For 'forward': local port to listen on. For 'reverse': local port of the service to expose. If omitted or set to 0, a random available port will be chosen."
            },
            remotePort: {
              type: "number",
              description: "For 'forward': remote port to connect to. For 'reverse': remote port to listen on the remote host."
            },
            agentName: {
              type: "string",
              description: "The name/identifier of the agent requesting the connection (e.g., 'OpenCode-Agent-Alpha')."
            },
            consentToken: {
              type: "string",
              description: "Optional. A token returned by a previous create_tunnel where the user chose 'Allow for this session'. If it matches this machine, the GUI prompt is skipped. Invalid/expired tokens (e.g. after a reboot) are reported so you can prompt again."
            }
          },
          required: ["target", "type", "remotePort", "agentName"]
        }
      },
      {
        name: "list_tunnels",
        description: "List all active tunnels currently managed by the MCP server.",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "close_tunnel",
        description: "Close an active tunnel by its Tunnel ID.",
        inputSchema: {
          type: "object",
          properties: {
            tunnelId: {
              type: "string",
              description: "The ID of the tunnel to close."
            }
          },
          required: ["tunnelId"]
        }
      },
      {
        name: "termius_tunnel_exec",
        description: "Execute a shell command directly on the remote host of an active tunnel using the established SSH connection. Does not require passing authTokens.",
        inputSchema: {
          type: "object",
          properties: {
            tunnelId: {
              type: "string",
              description: "The ID of the active tunnel."
            },
            command: {
              type: "string",
              description: "The shell command to execute."
            }
          },
          required: ["tunnelId", "command"]
        }
      },
      {
        name: "termius_shell_write",
        description: "Write data (command or input) to the stdin of the persistent interactive shell session of the active tunnel.",
        inputSchema: {
          type: "object",
          properties: {
            tunnelId: {
              type: "string",
              description: "The ID of the active tunnel."
            },
            data: {
              type: "string",
              description: "The data/command to write to the shell stdin. (e.g. 'cd ~/projects\\n')"
            }
          },
          required: ["tunnelId", "data"]
        }
      },
      {
        name: "termius_shell_read",
        description: "Read the accumulated stdout and stderr of the persistent interactive shell session.",
        inputSchema: {
          type: "object",
          properties: {
            tunnelId: {
              type: "string",
              description: "The ID of the active tunnel."
            },
            clear: {
              type: "boolean",
              description: "Whether to clear the accumulated buffer after reading. Defaults to false."
            }
          },
          required: ["tunnelId"]
        }
      },
      {
        name: "termius_start_task",
        description: "Start a shell command running asynchronously in the background on the remote host of the active tunnel. Returns a taskId.",
        inputSchema: {
          type: "object",
          properties: {
            tunnelId: {
              type: "string",
              description: "The ID of the active tunnel."
            },
            command: {
              type: "string",
              description: "The command to run in the background."
            }
          },
          required: ["tunnelId", "command"]
        }
      },
      {
        name: "termius_check_task",
        description: "Check the status and retrieve stdout/stderr of a background task.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "The ID of the background task."
            }
          },
          required: ["taskId"]
        }
      },
      {
        name: "termius_kill_task",
        description: "Terminate a running background task.",
        inputSchema: {
          type: "object",
          properties: {
            taskId: {
              type: "string",
              description: "The ID of the background task to kill."
            }
          },
          required: ["taskId"]
        }
      },
      {
        name: "termius_session_exec",
        description: "Execute a shell command inside the persistent interactive shell session of the active tunnel (CD/env persist across calls). Extremely fast because it reuses the same shell process.",
        inputSchema: {
          type: "object",
          properties: {
            tunnelId: {
              type: "string",
              description: "The ID of the active tunnel."
            },
            command: {
              type: "string",
              description: "The shell command to execute."
            },
            timeoutMs: {
              type: "number",
              description: "Command timeout in milliseconds. Defaults to 30000 (30 seconds)."
            }
          },
          required: ["tunnelId", "command"]
        }
      },
      {
        name: "termius_sftp_write",
        description: "Write PLAIN TEXT content directly to a file on the remote host of an active tunnel, over SFTP. `content` is written verbatim as UTF-8 — it is NOT base64-decoded. Do not base64-encode here; to transfer binary files use termius_sftp_upload instead. Creates parent directories as needed.",
        inputSchema: {
          type: "object",
          properties: {
            tunnelId: { type: "string", description: "The ID of the active tunnel." },
            remotePath: { type: "string", description: "Absolute path of the file to write on the remote host." },
            content: { type: "string", description: "The plain-text file content, written verbatim as UTF-8. Not base64." }
          },
          required: ["tunnelId", "remotePath", "content"]
        }
      },
      {
        name: "termius_sftp_read",
        description: "Read a file from the remote host of an active tunnel over SFTP and return its content. Use 'base64' encoding for binary files.",
        inputSchema: {
          type: "object",
          properties: {
            tunnelId: { type: "string", description: "The ID of the active tunnel." },
            remotePath: { type: "string", description: "Absolute path of the file to read on the remote host." },
            encoding: { type: "string", description: "How to return the content: 'utf8' (default) or 'base64'." },
            maxBytes: { type: "number", description: "Refuse to read files larger than this many bytes. Defaults to 10485760 (10 MiB)." }
          },
          required: ["tunnelId", "remotePath"]
        }
      },
      {
        name: "termius_sftp_upload",
        description: "Upload a local file (on the machine running this server) to the remote host of an active tunnel over SFTP.",
        inputSchema: {
          type: "object",
          properties: {
            tunnelId: { type: "string", description: "The ID of the active tunnel." },
            localPath: { type: "string", description: "Absolute path of the local file to upload." },
            remotePath: { type: "string", description: "Absolute destination path on the remote host." }
          },
          required: ["tunnelId", "localPath", "remotePath"]
        }
      },
      {
        name: "termius_sftp_download",
        description: "Download a file from the remote host of an active tunnel to the local machine running this server, over SFTP.",
        inputSchema: {
          type: "object",
          properties: {
            tunnelId: { type: "string", description: "The ID of the active tunnel." },
            remotePath: { type: "string", description: "Absolute path of the remote file to download." },
            localPath: { type: "string", description: "Absolute destination path on the local machine." }
          },
          required: ["tunnelId", "remotePath", "localPath"]
        }
      },
      {
        name: "termius_sftp_list",
        description: "List the contents of a directory on the remote host of an active tunnel over SFTP.",
        inputSchema: {
          type: "object",
          properties: {
            tunnelId: { type: "string", description: "The ID of the active tunnel." },
            remotePath: { type: "string", description: "Absolute directory path on the remote host." }
          },
          required: ["tunnelId", "remotePath"]
        }
      }
    ]
  };
});

// Helper to ensure Termius client is initialized
async function ensureTermiusInit() {
  if (!termius.initialized) {
    console.error("Initializing Termius client...");
    await termius.init();
  }
}

// Tool calls handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    await ensureTermiusInit();
  } catch (err) {
    return {
      content: [{ type: "text", text: `Failed to initialize Termius database: ${err.message}` }],
      isError: true
    };
  }

  if (name === "list_machines") {
    try {
      const conns = termius.getConnections();
        const list = conns.map(c => ({
          label: c.label,
          host: c.host,
          port: c.port,
          username: c.username,
          authType: c.authType,
          connectChain: (c.connectChain || []).map(chain => chain.label),
          os: c.os
        }));
      return {
        content: [{
          type: "text",
          text: JSON.stringify(list, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error fetching connections: ${err.message}` }],
        isError: true
      };
    }
  }

  if (name === "create_tunnel") {
    const { target, type, remotePort, agentName, consentToken } = args;
    let { localPort } = args;

    const connInfo = termius.getConnection(target);
    if (!connInfo) {
      return {
        content: [{ type: "text", text: `Could not find machine matching target: "${target}"` }],
        isError: true
      };
    }

    // A valid session consent token for this machine skips the GUI prompt.
    let grantedSessionToken = null;
    if (consentTokenValidFor(consentToken, connInfo.label)) {
      console.error(`Reusing session consent for Agent "${agentName}" to Host "${connInfo.label}" (no prompt).`);
    } else {
      if (consentToken) {
        return errResp(
          `The consentToken provided is not valid for machine "${connInfo.label}" (it may be for a different machine, or this computer has restarted and cleared it). ` +
          `Call create_tunnel without consentToken to prompt the user again.`
        );
      }
      console.error(`Triggering GUI authorization for Agent: "${agentName}" to Host: "${connInfo.label}"`);
      const authorization = await requestGuiAuthorization(agentName, connInfo.label);

      if (authorization.decision === "deny") {
        console.error(`Access DENIED by user for Agent "${agentName}" to Host "${connInfo.label}"`);
        return errResp(
          `❌ The user DENIED access to "${connInfo.label}". ${authorization.reason} ` +
          `Do NOT retry automatically — the user explicitly refused. Ask the user directly if they want to allow it.`
        );
      }
      if (authorization.decision === "no_response") {
        console.error(`No response from user for Agent "${agentName}" to Host "${connInfo.label}"`);
        return errResp(
          `⏳ No response: ${authorization.reason} ` +
          `This is NOT a denial — nobody chose anything. If you expect the user to be back, you may call create_tunnel again later to re-prompt; otherwise tell the user a connection to "${connInfo.label}" is waiting for their approval.`
        );
      }
      if (authorization.decision === "unavailable") {
        console.error(`Authorization dialog unavailable for Host "${connInfo.label}": ${authorization.reason}`);
        return errResp(
          `⚠️ Cannot ask the user for authorization: ${authorization.reason} ` +
          `Without a working dialog this connection cannot be approved. Tell the user to install a dialog tool (kdialog or zenity on Linux) or run where a GUI is available.`
        );
      }
      if (authorization.decision === "allow_session") {
        grantedSessionToken = grantSessionConsent(connInfo.label, agentName);
        console.error(`Session consent GRANTED for Agent "${agentName}" to Host "${connInfo.label}"`);
      } else {
        console.error(`Access granted (once) by user for Agent "${agentName}" to Host "${connInfo.label}"`);
      }
    }

    const tunnelId = `tunnel-${++tunnelCounter}`;
    const authToken = generateToken();

    return new Promise((resolve) => {
      let resolved = false;
      let sshClient;
      let sshClients = [];

      const finishError = (msg) => {
        if (resolved) return;
        resolved = true;
        sshClients.forEach(client => client.end());
        resolve({
          content: [{ type: "text", text: msg }],
          isError: true
        });
      };

      connectThroughChain(connInfo).then(({ client, clients }) => {
        sshClient = client;
        sshClients = clients;
        sshClient.on("error", (err) => {
          console.error(`SSH client error for tunnel ${tunnelId}:`, err);
          finishError(`SSH connection failed: ${err.message}`);
        });

        console.error(`SSH Client ready for tunnel ${tunnelId}`);
        
        if (type === "forward") {
          // Local Port Forwarding: localServer listens locally, proxies via SSH to remote
          const localServer = net.createServer((socket) => {
            let buffer = Buffer.alloc(0);
            
            const onData = (chunk) => {
              buffer = Buffer.concat([buffer, chunk]);
              const newlineIndex = buffer.indexOf("\n");
              const nullIndex = buffer.indexOf("\0");
              const splitIndex = newlineIndex !== -1 ? newlineIndex : nullIndex;
              
              if (splitIndex !== -1) {
                const token = buffer.slice(0, splitIndex).toString().trim();
                const remaining = buffer.slice(splitIndex + 1);
                
                socket.removeListener("data", onData);
                
                if (token === authToken) {
                  // Authenticated! Establish tunnel through SSH
                  sshClient.forwardOut("127.0.0.1", socket.remotePort, "127.0.0.1", remotePort, (err, stream) => {
                    if (err) {
                      console.error("SSH forwardOut error:", err);
                      socket.end();
                      return;
                    }
                    if (remaining.length > 0) {
                      stream.write(remaining);
                    }
                    socket.pipe(stream).pipe(socket);
                  });
                } else {
                  console.error(`Tunnel authentication failed for ${tunnelId}: invalid token.`);
                  socket.write("Auth failed: Invalid token.\n");
                  socket.end();
                }
              } else if (buffer.length > 1024) {
                console.error(`Tunnel authentication failed for ${tunnelId}: token too long.`);
                socket.end();
              }
            };
            
            socket.on("data", onData);
            setTimeout(() => {
              if (socket.listenerCount("data") > 0) {
                console.error(`Tunnel authentication timeout for ${tunnelId}`);
                socket.end();
              }
            }, 3000);
          });

          localServer.listen(localPort || 0, "127.0.0.1", () => {
            const actualLocalPort = localServer.address().port;
            activeTunnels.set(tunnelId, {
              tunnelId,
              type,
              target: connInfo.label,
              connectChain: (connInfo.connectChain || []).map(connection => connection.label),
              localPort: actualLocalPort,
              remotePort,
              authToken,
              sshClient,
              sshClients,
              localServer
            });
            wireTunnelLifecycle(tunnelId, sshClient);

            resolved = true;
            resolve({
              content: [{
                type: "text",
                text: JSON.stringify({
                  tunnelId,
                  status: "established",
                  type,
                  localAddress: `127.0.0.1:${actualLocalPort}`,
                  remoteTarget: `${connInfo.host}:${remotePort}`,
                  authToken,
                  consentToken: grantedSessionToken || undefined,
                  consentNote: grantedSessionToken
                    ? `The user allowed this machine for the whole session. Reuse consentToken on future create_tunnel calls to "${connInfo.label}" to skip the prompt until this computer restarts.`
                    : undefined,
                  instruction: `To connect, open a TCP connection to 127.0.0.1:${actualLocalPort} and send the authToken "${authToken}" followed by a newline (\\n) within 3 seconds.`
                }, null, 2)
              }]
            });
          });

          localServer.on("error", (err) => {
            finishError(`Failed to start local proxy server: ${err.message}`);
          });

        } else if (type === "reverse") {
          // Reverse Port Forwarding: expose localPort back to remotePort on remote server
          sshClient.forwardIn("127.0.0.1", remotePort, (err) => {
            if (err) {
              finishError(`Failed to establish remote port forwarding on remote port ${remotePort}: ${err.message}`);
              return;
            }

            // Monitor connections coming back from the remote server
            sshClient.on("tcp connection", (info, accept, reject) => {
              if (info.destPort !== remotePort) {
                reject();
                return;
              }

              const stream = accept();
              let buffer = Buffer.alloc(0);
              
              const onData = (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                const newlineIndex = buffer.indexOf("\n");
                const nullIndex = buffer.indexOf("\0");
                const splitIndex = newlineIndex !== -1 ? newlineIndex : nullIndex;
                
                if (splitIndex !== -1) {
                  const token = buffer.slice(0, splitIndex).toString().trim();
                  const remaining = buffer.slice(splitIndex + 1);
                  
                  stream.removeListener("data", onData);
                  
                  if (token === authToken) {
                    // Authenticated! Connect to our local service port
                    const localSocket = net.connect(localPort, "127.0.0.1", () => {
                      if (remaining.length > 0) {
                        localSocket.write(remaining);
                      }
                      stream.pipe(localSocket).pipe(stream);
                    });
                    
                    localSocket.on("error", (err) => {
                      console.error(`Local socket connection failed for ${tunnelId}:`, err);
                      stream.end();
                    });
                  } else {
                    console.error(`Reverse tunnel auth failed: invalid token.`);
                    stream.write("Auth failed: Invalid token.\n");
                    stream.end();
                  }
                } else if (buffer.length > 1024) {
                  console.error(`Reverse tunnel auth failed: token too long.`);
                  stream.end();
                }
              };
              
              stream.on("data", onData);
              setTimeout(() => {
                if (stream.listenerCount("data") > 0) {
                  console.error(`Reverse tunnel auth timeout.`);
                  stream.end();
                }
              }, 3000);
            });

            activeTunnels.set(tunnelId, {
              tunnelId,
              type,
              target: connInfo.label,
              connectChain: (connInfo.connectChain || []).map(connection => connection.label),
              localPort,
              remotePort,
              authToken,
              sshClient,
              sshClients
            });
            wireTunnelLifecycle(tunnelId, sshClient);

            resolved = true;
            resolve({
              content: [{
                type: "text",
                text: JSON.stringify({
                  tunnelId,
                  status: "established",
                  type,
                  remoteAddress: `127.0.0.1:${remotePort} (on remote host)`,
                  localTarget: `127.0.0.1:${localPort}`,
                  authToken,
                  consentToken: grantedSessionToken || undefined,
                  consentNote: grantedSessionToken
                    ? `The user allowed this machine for the whole session. Reuse consentToken on future create_tunnel calls to "${connInfo.label}" to skip the prompt until this computer restarts.`
                    : undefined,
                  instruction: `On the remote host, connect to 127.0.0.1:${remotePort} and send the authToken "${authToken}" followed by a newline (\\n) within 3 seconds to access the local service.`
                }, null, 2)
              }]
            });
          });
        }
      }).catch(err => finishError(`SSH connection failed: ${err.message}`));
    });
  }

  if (name === "list_tunnels") {
    const list = Array.from(activeTunnels.values()).map(t => ({
      tunnelId: t.tunnelId,
      type: t.type,
      target: t.target,
      localPort: t.localPort,
      remotePort: t.remotePort,
      connectChain: t.connectChain || [],
      hasAuthToken: !!t.authToken
    }));
    return {
      content: [{
        type: "text",
        text: JSON.stringify(list, null, 2)
      }]
    };
  }

  if (name === "termius_tunnel_exec") {
    const { tunnelId, command } = args;
    const tr = getTunnel(tunnelId);
    if (tr.error) return tr.error;
    const tunnel = tr.tunnel;

    return new Promise((resolve) => {
      const startTime = Date.now();
      sshExec(tunnel.sshClient, command, (res) => {
        if (res.error) {
          const msg = /not connected/i.test(res.error)
            ? `Tunnel "${tunnelId}" lost its SSH connection mid-command (${res.error}). Call close_tunnel then create_tunnel again.`
            : `Failed to execute command: ${res.error}`;
          resolve(errResp(msg));
          return;
        }
        resolve({
          content: [{
            type: "text",
            text: JSON.stringify({
              stdout: res.stdout,
              stderr: res.stderr,
              exitCode: res.exitCode,
              signal: res.signal,
              usedPty: res.usedPty,
              durationMs: Date.now() - startTime
            }, null, 2)
          }]
        });
      });
    });
  }

  if (name === "termius_shell_write") {
    const { tunnelId, data } = args;
    const tr = getTunnel(tunnelId);
    if (tr.error) return tr.error;
    const tunnel = tr.tunnel;

    try {
      const stream = await getOrCreateShell(tunnel);
      stream.write(data);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, message: "Data written to shell stdin" }, null, 2) }]
      };
    } catch (err) {
      const msg = /not connected/i.test(err.message)
        ? `Tunnel "${tunnelId}" lost its SSH connection (${err.message}). Call close_tunnel then create_tunnel again.`
        : `Failed to interact with shell: ${err.message}`;
      return errResp(msg);
    }
  }

  if (name === "termius_shell_read") {
    const { tunnelId, clear = false } = args;
    const tr = getTunnel(tunnelId);
    if (tr.error) return tr.error;
    const tunnel = tr.tunnel;

    const stdout = tunnel.shellStdout || "";
    const stderr = tunnel.shellStderr || "";

    if (clear) {
      tunnel.shellStdout = "";
      tunnel.shellStderr = "";
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          stdout,
          stderr,
          isShellActive: !!tunnel.shellStream
        }, null, 2)
      }]
    };
  }

  if (name === "termius_start_task") {
    const { tunnelId, command } = args;
    const tr = getTunnel(tunnelId);
    if (tr.error) return tr.error;
    const tunnel = tr.tunnel;

    const taskId = `task-${++taskCounter}`;
    const task = {
      taskId,
      tunnelId,
      command,
      status: "running",
      exitCode: null,
      stdout: "",
      stderr: "",
      stream: null
    };

    activeTasks.set(taskId, task);

    tunnel.sshClient.exec(command, (err, stream) => {
      if (err) {
        task.status = "failed";
        task.stderr = err.message;
        console.error(`Failed to start background task ${taskId}:`, err);
        return;
      }

      task.stream = stream;

      stream.on("data", (data) => {
        task.stdout += data.toString();
      });

      stream.stderr.on("data", (data) => {
        task.stderr += data.toString();
      });

      stream.on("close", (code, signal) => {
        task.status = "finished";
        task.exitCode = code ?? (signal ? -1 : 0);
        task.stream = null;
        console.error(`Background task ${taskId} closed with exit code ${task.exitCode}`);
      });
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          taskId,
          status: "running",
          command
        }, null, 2)
      }]
    };
  }

  if (name === "termius_check_task") {
    const { taskId } = args;
    const task = activeTasks.get(taskId);
    if (!task) {
      return {
        content: [{ type: "text", text: `Task with ID "${taskId}" not found.` }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          taskId,
          tunnelId: task.tunnelId,
          command: task.command,
          status: task.status,
          exitCode: task.exitCode,
          stdout: task.stdout,
          stderr: task.stderr
        }, null, 2)
      }]
    };
  }

  if (name === "termius_kill_task") {
    const { taskId } = args;
    const task = activeTasks.get(taskId);
    if (!task) {
      return {
        content: [{ type: "text", text: `Task with ID "${taskId}" not found.` }],
        isError: true
      };
    }

    if (task.status === "running") {
      if (task.stream) {
        try {
          task.stream.close();
        } catch (e) {
          // ignore
        }
      }
      task.status = "killed";
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          taskId,
          status: task.status
        }, null, 2)
      }]
    };
  }

  if (name === "termius_session_exec") {
    const { tunnelId, command, timeoutMs = 30000 } = args;
    const tr = getTunnel(tunnelId);
    if (tr.error) return tr.error;
    const tunnel = tr.tunnel;

    try {
      const res = await sessionExec(tunnel, command, timeoutMs);
      if (res.error) {
        const msg = /not connected/i.test(res.error)
          ? `Tunnel "${tunnelId}" lost its SSH connection (${res.error}). Call close_tunnel then create_tunnel again.`
          : `Failed to execute: ${res.error}`;
        return errResp(msg);
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            stdout: res.stdout,
            stderr: res.stderr,
            exitCode: res.exitCode
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }

  if (name === "close_tunnel") {
    const { tunnelId } = args;
    // Deliberately lenient: close works even on a dead tunnel so the agent can
    // clean up and recreate.
    const tunnel = activeTunnels.get(tunnelId);
    if (!tunnel) {
      const open = Array.from(activeTunnels.keys());
      return errResp(
        `Tunnel "${tunnelId}" not found (already closed or never created).` +
        (open.length ? ` Open tunnels: ${open.join(", ")}.` : ` No tunnels are open.`)
      );
    }

    try {
      try { if (tunnel.shellStream) tunnel.shellStream.close(); } catch {}
      try { if (tunnel.sftp) tunnel.sftp.end(); } catch {}
      if (tunnel.localServer) {
        tunnel.localServer.close();
      }
      if (tunnel.sshClients) {
        tunnel.sshClients.forEach(client => client.end());
      } else if (tunnel.sshClient) {
        tunnel.sshClient.end();
      }
      activeTunnels.delete(tunnelId);
      return {
        content: [{ type: "text", text: `Successfully closed tunnel "${tunnelId}".` }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error closing tunnel: ${err.message}` }],
        isError: true
      };
    }
  }

  if (name === "termius_sftp_write" || name === "termius_sftp_read" ||
      name === "termius_sftp_upload" || name === "termius_sftp_download" ||
      name === "termius_sftp_list") {
    const tr = getTunnel(args.tunnelId);
    if (tr.error) return tr.error;
    const tunnel = tr.tunnel;
    try {
      const sftp = await getSftp(tunnel);
      const mkdirp = (dir) => new Promise((resolve) => {
        // Best-effort recursive mkdir; ignores "already exists".
        const parts = dir.split("/").filter(Boolean);
        let cur = dir.startsWith("/") ? "" : ".";
        const next = (i) => {
          if (i >= parts.length) return resolve();
          cur += "/" + parts[i];
          sftp.mkdir(cur, () => next(i + 1));
        };
        next(0);
      });

      if (name === "termius_sftp_write") {
        const { remotePath, content } = args;
        // Plain text only: content is written verbatim as UTF-8, never
        // base64-decoded. Binary transfers must use termius_sftp_upload.
        const buf = Buffer.from(String(content), "utf8");
        await mkdirp(path.posix.dirname(remotePath));
        await new Promise((resolve, reject) => {
          sftp.writeFile(remotePath, buf, (err) => (err ? reject(err) : resolve()));
        });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, remotePath, bytesWritten: buf.length }) }] };
      }

      if (name === "termius_sftp_read") {
        const { remotePath, encoding = "utf8", maxBytes = 10 * 1024 * 1024 } = args;
        const stat = await new Promise((resolve, reject) => sftp.stat(remotePath, (err, s) => (err ? reject(err) : resolve(s))));
        if (stat.size > maxBytes) {
          return { content: [{ type: "text", text: `File is ${stat.size} bytes, larger than maxBytes (${maxBytes}). Increase maxBytes or download it instead.` }], isError: true };
        }
        const buf = await new Promise((resolve, reject) => sftp.readFile(remotePath, (err, d) => (err ? reject(err) : resolve(d))));
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, remotePath, size: buf.length, encoding, content: buf.toString(encoding === "base64" ? "base64" : "utf8") }) }] };
      }

      if (name === "termius_sftp_upload") {
        const { localPath, remotePath } = args;
        if (!fs.existsSync(localPath)) {
          return { content: [{ type: "text", text: `Local file not found: ${localPath}` }], isError: true };
        }
        await mkdirp(path.posix.dirname(remotePath));
        await new Promise((resolve, reject) => sftp.fastPut(localPath, remotePath, (err) => (err ? reject(err) : resolve())));
        const size = fs.statSync(localPath).size;
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, localPath, remotePath, bytes: size }) }] };
      }

      if (name === "termius_sftp_download") {
        const { remotePath, localPath } = args;
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        await new Promise((resolve, reject) => sftp.fastGet(remotePath, localPath, (err) => (err ? reject(err) : resolve())));
        const size = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, remotePath, localPath, bytes: size }) }] };
      }

      if (name === "termius_sftp_list") {
        const { remotePath } = args;
        const list = await new Promise((resolve, reject) => sftp.readdir(remotePath, (err, l) => (err ? reject(err) : resolve(l))));
        const entries = list.map((e) => ({
          name: e.filename,
          type: (e.attrs.mode & 0o170000) === 0o040000 ? "dir" : ((e.attrs.mode & 0o170000) === 0o120000 ? "link" : "file"),
          size: e.attrs.size,
          mode: (e.attrs.mode & 0o777).toString(8),
          mtime: e.attrs.mtime
        }));
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, remotePath, entries }, null, 2) }] };
      }
    } catch (err) {
      const msg = /not connected|channel open failure|no response/i.test(err.message)
        ? `Tunnel "${args.tunnelId}" lost its SSH connection during the SFTP operation (${err.message}). Call close_tunnel then create_tunnel again.`
        : `SFTP error: ${err.message}`;
      return errResp(msg);
    }
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Termius MCP Server running on stdio transport");
}

main().catch((err) => {
  console.error("Fatal error in main:", err);
  process.exit(1);
});
