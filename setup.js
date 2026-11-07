// termius-mcp setup — detect installed MCP-capable agents and offer to add the
// termius MCP server to their config. Shared by the `termius-mcp setup` command
// and the postinstall hook. Never throws out of the public helpers; every write
// backs up the target file first and is idempotent.

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { execFileSync } = require("child_process");

const DISPLAY = process.env.DISPLAY || ":0";
const envBlock = process.platform === "linux" ? { DISPLAY } : undefined; // mac/win need no DISPLAY

function hasCommand(cmd) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch { return false; }
}

function readJsonSafe(file) {
  try {
    let txt = fs.readFileSync(file, "utf8");
    // tolerate JSONC: strip /* */ and // comments (best effort)
    txt = txt.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    return JSON.parse(txt);
  } catch { return null; }
}

function backup(file) {
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
  } catch {}
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backup(file);
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

// --- per-agent config shape -------------------------------------------------
function opencodeEntry() {
  const e = { type: "local", command: ["termius-mcp"] };
  if (envBlock) e.environment = envBlock;
  return e;
}
function genericEntry() {
  const e = { command: "termius-mcp" };
  if (envBlock) e.env = envBlock;
  return e;
}

function configDir() {
  if (process.platform === "win32") return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

// Each agent: { id, label, locate() -> path|null|"cli", apply() -> {status, detail} }
function agents() {
  const list = [];

  // opencode
  {
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const file = path.join(base, "opencode", "opencode.json");
    const jsonc = path.join(base, "opencode", "opencode.jsonc");
    const found = fs.existsSync(file) ? file : (fs.existsSync(jsonc) ? jsonc : null);
    list.push({
      id: "opencode", label: "opencode", target: found || file,
      detected: !!found,
      apply() {
        const f = found || file;
        const cfg = readJsonSafe(f) || {};
        cfg.mcp = cfg.mcp || {};
        if (cfg.mcp.termius) return { status: "exists", detail: f };
        cfg.mcp.termius = opencodeEntry();
        writeJson(f, cfg);
        return { status: "added", detail: f };
      }
    });
  }

  // Claude Code (prefer the CLI; it owns ~/.claude.json)
  {
    const cli = hasCommand("claude");
    list.push({
      id: "claude-code", label: "Claude Code", target: "claude CLI",
      detected: cli,
      apply() {
        if (!cli) return { status: "skip", detail: "claude CLI not found" };
        try { execFileSync("claude", ["mcp", "get", "termius"], { stdio: "ignore" }); return { status: "exists", detail: "claude user config" }; } catch {}
        const args = ["mcp", "add", "termius", "-s", "user"];
        if (envBlock) args.push("-e", `DISPLAY=${DISPLAY}`);
        args.push("--", "termius-mcp");
        execFileSync("claude", args, { stdio: "ignore" });
        return { status: "added", detail: "claude user config" };
      }
    });
  }

  // Claude Desktop
  {
    const file = path.join(configDir(), "Claude", "claude_desktop_config.json");
    list.push({
      id: "claude-desktop", label: "Claude Desktop", target: file,
      detected: fs.existsSync(file),
      apply() {
        const cfg = readJsonSafe(file) || {};
        cfg.mcpServers = cfg.mcpServers || {};
        if (cfg.mcpServers.termius) return { status: "exists", detail: file };
        cfg.mcpServers.termius = genericEntry();
        writeJson(file, cfg);
        return { status: "added", detail: file };
      }
    });
  }

  // Pi (earendil-works/pi coding agent) — ~/.pi/agent/mcp.json, mcpServers shape
  {
    const dir = path.join(os.homedir(), ".pi");
    const file = path.join(dir, "agent", "mcp.json");
    list.push({
      id: "pi", label: "Pi", target: file,
      detected: fs.existsSync(file) || fs.existsSync(dir) || hasCommand("pi"),
      apply() {
        const cfg = readJsonSafe(file) || {};
        cfg.mcpServers = cfg.mcpServers || {};
        if (cfg.mcpServers.termius) return { status: "exists", detail: file };
        cfg.mcpServers.termius = genericEntry();
        writeJson(file, cfg);
        return { status: "added", detail: file };
      }
    });
  }

  // Codex (OpenAI codex CLI) — ~/.codex/config.toml, [mcp_servers.<name>] TOML
  {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const file = path.join(home, "config.toml");
    list.push({
      id: "codex", label: "Codex", target: file,
      detected: fs.existsSync(file) || fs.existsSync(home) || hasCommand("codex"),
      apply() {
        let existing = "";
        try { existing = fs.readFileSync(file, "utf8"); } catch {}
        if (/\[mcp_servers\.termius\]/.test(existing)) return { status: "exists", detail: file };
        // Prefer the CLI, which writes the TOML table correctly.
        if (hasCommand("codex")) {
          const args = ["mcp", "add", "termius"];
          if (envBlock) for (const [k, v] of Object.entries(envBlock)) args.push("--env", `${k}=${v}`);
          args.push("--", "termius-mcp");
          execFileSync("codex", args, { stdio: "ignore" });
          return { status: "added", detail: `${file} (codex mcp add)` };
        }
        // Fallback: append a TOML table (order-independent in TOML, so appending
        // is safe as long as the table isn't already present).
        let block = `\n[mcp_servers.termius]\ncommand = "termius-mcp"\n`;
        if (envBlock) {
          block += `\n[mcp_servers.termius.env]\n`;
          for (const [k, v] of Object.entries(envBlock)) block += `${k} = ${JSON.stringify(v)}\n`;
        }
        fs.mkdirSync(home, { recursive: true });
        backup(file);
        fs.appendFileSync(file, block);
        return { status: "added", detail: file };
      }
    });
  }

  // Windsurf (Codeium) — ~/.codeium/windsurf/mcp_config.json, mcpServers shape
  {
    const file = path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json");
    list.push({
      id: "windsurf", label: "Windsurf", target: file,
      detected: fs.existsSync(file) || fs.existsSync(path.join(os.homedir(), ".codeium", "windsurf")),
      apply() {
        const cfg = readJsonSafe(file) || {};
        cfg.mcpServers = cfg.mcpServers || {};
        if (cfg.mcpServers.termius) return { status: "exists", detail: file };
        cfg.mcpServers.termius = genericEntry();
        writeJson(file, cfg);
        return { status: "added", detail: file };
      }
    });
  }

  // Cline — cline_mcp_settings.json (VS Code extension or standalone CLI)
  {
    const vscode = path.join(configDir(), "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
    const cli = path.join(os.homedir(), ".cline", "data", "settings", "cline_mcp_settings.json");
    const file = fs.existsSync(vscode) ? vscode : (fs.existsSync(cli) ? cli : vscode);
    list.push({
      id: "cline", label: "Cline", target: file,
      detected: fs.existsSync(vscode) || fs.existsSync(cli),
      apply() {
        const cfg = readJsonSafe(file) || {};
        cfg.mcpServers = cfg.mcpServers || {};
        if (cfg.mcpServers.termius) return { status: "exists", detail: file };
        cfg.mcpServers.termius = genericEntry();
        writeJson(file, cfg);
        return { status: "added", detail: file };
      }
    });
  }

  // Zed — ~/.config/zed/settings.json, top-level `context_servers`
  {
    const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "zed", "settings.json");
    list.push({
      id: "zed", label: "Zed", target: file,
      detected: fs.existsSync(file),
      apply() {
        const cfg = readJsonSafe(file) || {};
        cfg.context_servers = cfg.context_servers || {};
        if (cfg.context_servers.termius) return { status: "exists", detail: file };
        const entry = { source: "custom", command: "termius-mcp", args: [] };
        if (envBlock) entry.env = envBlock;
        cfg.context_servers.termius = entry;
        writeJson(file, cfg);
        return { status: "added", detail: file };
      }
    });
  }

  // Continue — a standalone block file under ~/.continue/mcpServers/ (so we
  // never have to merge into the user's main config.yaml).
  {
    const dir = path.join(os.homedir(), ".continue");
    const file = path.join(dir, "mcpServers", "termius.yaml");
    list.push({
      id: "continue", label: "Continue", target: file,
      detected: fs.existsSync(dir),
      apply() {
        if (fs.existsSync(file)) return { status: "exists", detail: file };
        let yaml = "name: Termius\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: termius\n    command: termius-mcp\n";
        if (envBlock) {
          yaml += "    env:\n";
          for (const [k, v] of Object.entries(envBlock)) yaml += `      ${k}: ${JSON.stringify(v)}\n`;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, yaml);
        return { status: "added", detail: file };
      }
    });
  }

  // Cursor
  {
    const file = path.join(os.homedir(), ".cursor", "mcp.json");
    list.push({
      id: "cursor", label: "Cursor", target: file,
      detected: fs.existsSync(file),
      apply() {
        const cfg = readJsonSafe(file) || {};
        cfg.mcpServers = cfg.mcpServers || {};
        if (cfg.mcpServers.termius) return { status: "exists", detail: file };
        cfg.mcpServers.termius = genericEntry();
        writeJson(file, cfg);
        return { status: "added", detail: file };
      }
    });
  }

  // Antigravity (Google) — ~/.gemini/config/mcp_config.json, mcpServers shape.
  // (Gemini CLI was folded into Antigravity; it reuses the ~/.gemini namespace.)
  {
    const dir = path.join(os.homedir(), ".gemini");
    const file = path.join(dir, "config", "mcp_config.json");
    list.push({
      id: "antigravity", label: "Antigravity", target: file,
      detected: fs.existsSync(file) || fs.existsSync(path.join(dir, "config")) || fs.existsSync(dir),
      apply() {
        const cfg = readJsonSafe(file) || {};
        cfg.mcpServers = cfg.mcpServers || {};
        if (cfg.mcpServers.termius) return { status: "exists", detail: file };
        cfg.mcpServers.termius = genericEntry();
        writeJson(file, cfg);
        return { status: "added", detail: file };
      }
    });
  }

  // Amazon Q Developer CLI — ~/.aws/amazonq/mcp.json, mcpServers shape
  {
    const dir = path.join(os.homedir(), ".aws", "amazonq");
    const file = path.join(dir, "mcp.json");
    list.push({
      id: "amazon-q", label: "Amazon Q", target: file,
      detected: fs.existsSync(dir) || hasCommand("q"),
      apply() {
        const cfg = readJsonSafe(file) || {};
        cfg.mcpServers = cfg.mcpServers || {};
        if (cfg.mcpServers.termius) return { status: "exists", detail: file };
        cfg.mcpServers.termius = genericEntry();
        writeJson(file, cfg);
        return { status: "added", detail: file };
      }
    });
  }

  // Kilo Code — VS Code extension globalStorage mcp_settings.json, mcpServers shape
  {
    const file = path.join(configDir(), "Code", "User", "globalStorage", "kilocode.kilo-code", "settings", "mcp_settings.json");
    list.push({
      id: "kilo-code", label: "Kilo Code", target: file,
      detected: fs.existsSync(path.dirname(file)) || fs.existsSync(file),
      apply() {
        const cfg = readJsonSafe(file) || {};
        cfg.mcpServers = cfg.mcpServers || {};
        if (cfg.mcpServers.termius) return { status: "exists", detail: file };
        cfg.mcpServers.termius = genericEntry();
        writeJson(file, cfg);
        return { status: "added", detail: file };
      }
    });
  }

  // VS Code (native MCP / Copilot agent) — user-level mcp.json, `servers` key
  // with a per-server `type`.
  {
    const file = path.join(configDir(), "Code", "User", "mcp.json");
    list.push({
      id: "vscode", label: "VS Code", target: file,
      detected: fs.existsSync(path.join(configDir(), "Code", "User")),
      apply() {
        const cfg = readJsonSafe(file) || {};
        cfg.servers = cfg.servers || {};
        if (cfg.servers.termius) return { status: "exists", detail: file };
        const entry = { type: "stdio", command: "termius-mcp", args: [] };
        if (envBlock) entry.env = envBlock;
        cfg.servers.termius = entry;
        writeJson(file, cfg);
        return { status: "added", detail: file };
      }
    });
  }

  return list;
}

function detectAgents() { return agents().filter(a => a.detected); }

function manualHint() {
  const envLine = envBlock ? `, "env": { "DISPLAY": "${DISPLAY}" }` : "";
  return [
    "To use termius-mcp, add it to your agent's MCP config, e.g.:",
    `  { "command": "termius-mcp"${envLine} }`,
    "or run:  termius-mcp setup",
    "(requires the Termius desktop app installed & logged in, and a desktop GUI for the approval dialog)"
  ].join("\n");
}

function applyTo(list) {
  for (const a of list) {
    try {
      const r = a.apply();
      const mark = r.status === "added" ? "✓ configured" : r.status === "exists" ? "• already configured" : "- skipped";
      console.log(`  ${mark}: ${a.label} (${r.detail})`);
    } catch (e) {
      console.log(`  ✗ ${a.label}: ${e.message}. Configure manually.`);
    }
  }
}

// Interactive-aware prompt with a timeout. Resolves true (yes), false (no),
// or null (no answer within `ms` — treated as "skip").
function promptYesNo(question, ms) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return resolve(null);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); rl.close(); resolve(v); };
    const timer = setTimeout(() => { process.stdout.write("\n"); finish(null); }, ms);
    rl.question(question, (ans) => {
      const a = (ans || "").trim().toLowerCase();
      finish(a === "" || a === "y" || a === "yes");
    });
  });
}

// Shown after every run so people can contribute a detector for an agent we
// don't cover yet. The GitHub "edit file" link opens setup.js ready to fork,
// edit, and open a pull request in one flow.
const CONTRIBUTE =
  "Don't see your agent / harness? Add it in a quick PR:\n" +
  "  https://github.com/mcg25035/termius-mcp/edit/master/setup.js";

// CLI: `termius-mcp setup [--yes] [--print]`
async function cli(argv) {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const printOnly = argv.includes("--print");
  const found = detectAgents();

  if (printOnly) { console.log(manualHint()); console.log("\n" + CONTRIBUTE); return; }

  if (!found.length) {
    console.log("No supported agents detected.");
    console.log(manualHint());
    console.log("\n" + CONTRIBUTE);
    return;
  }

  console.log("Detected agents: " + found.map(a => a.label).join(", "));
  let go = yes;
  if (!go) {
    const ans = await promptYesNo("Add the termius MCP server to them now? [Y/n] ", 30000);
    go = ans === true || ans === null && false; // in explicit `setup`, null (timeout) = no
  }
  if (!go) {
    console.log("Skipped. Run `termius-mcp setup --yes` to configure non-interactively.");
    console.log("\n" + CONTRIBUTE);
    return;
  }

  console.log("Configuring:");
  applyTo(found);
  console.log("Done. Restart your agent to pick up the new MCP server.");
  console.log("\n" + CONTRIBUTE);
}

module.exports = { detectAgents, applyTo, promptYesNo, manualHint, cli, CONTRIBUTE };
