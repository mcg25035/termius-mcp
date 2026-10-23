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

// CLI: `termius-mcp setup [--yes] [--print]`
async function cli(argv) {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const printOnly = argv.includes("--print");
  const found = detectAgents();

  if (printOnly) { console.log(manualHint()); return; }

  if (!found.length) {
    console.log("No supported agents detected (opencode, Claude Code, Claude Desktop, Cursor).");
    console.log(manualHint());
    return;
  }

  console.log("Detected agents: " + found.map(a => a.label).join(", "));
  let go = yes;
  if (!go) {
    const ans = await promptYesNo("Add the termius MCP server to them now? [Y/n] ", 30000);
    go = ans === true || ans === null && false; // in explicit `setup`, null (timeout) = no
  }
  if (!go) { console.log("Skipped. Run `termius-mcp setup --yes` to configure non-interactively."); return; }

  console.log("Configuring:");
  applyTo(found);
  console.log("Done. Restart your agent to pick up the new MCP server.");
}

module.exports = { detectAgents, applyTo, promptYesNo, manualHint, cli };
