// postinstall — best-effort, never fails the install.
//
// - Non-interactive (no TTY, CI, or scripts ignored): just print the hint.
// - Interactive: detect agents and offer to configure, but auto-skip after 10s
//   of no input (a quiet install must never hang, and we never touch a user's
//   config without an explicit "yes").
(async () => {
  try {
    // Skip entirely during local dev installs of this very package.
    if (process.env.npm_config_global !== "true" && process.env.TERMIUS_MCP_FORCE_POSTINSTALL !== "1") {
      return;
    }
    const setup = require("./setup");
    const nonInteractive =
      !process.stdin.isTTY || !process.stdout.isTTY ||
      process.env.CI || process.env.npm_config_ignore_scripts === "true";

    const found = setup.detectAgents();

    if (nonInteractive || !found.length) {
      console.log("\n[termius-mcp] " + (found.length
        ? `Detected: ${found.map(a => a.label).join(", ")}.`
        : "No agents detected."));
      console.log("[termius-mcp] Run `termius-mcp setup` to configure your agent.\n");
      return;
    }

    console.log(`\n[termius-mcp] Detected: ${found.map(a => a.label).join(", ")}.`);
    const ans = await setup.promptYesNo(
      "[termius-mcp] Add the termius MCP server to them now? [Y/n] (auto-skip in 10s) ",
      10000
    );
    if (ans === true) {
      console.log("[termius-mcp] Configuring:");
      setup.applyTo(found);
      console.log("[termius-mcp] Done. Restart your agent to pick it up.\n");
    } else {
      // No, or 10s timeout → do not modify anything, just point to setup.
      console.log("[termius-mcp] Skipped. Run `termius-mcp setup` anytime to configure.\n");
    }
  } catch {
    // Must never break the install.
    try { console.log("[termius-mcp] Installed. Run `termius-mcp setup` to configure your agent."); } catch {}
  }
})();
