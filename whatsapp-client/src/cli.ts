#!/usr/bin/env node
// =============================================================================
// Operator CLI: tiny helpers for setup and sanity checks.
//   --print-qr        Force re-pairing: remove session dir and start fresh.
//   --check-groups    Validate env config and print the four group JIDs.
//   --send-test       (TODO: requires Integrator wired) — sends a test prompt
//                     to each configured group and waits for an echo.
// =============================================================================

import { existsSync, rmSync } from "node:fs";
import { loadConfig } from "./config.js";

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--print-qr")) {
    const { runtime } = loadConfig();
    if (existsSync(runtime.sessionPath)) {
      rmSync(runtime.sessionPath, { recursive: true, force: true });
      process.stdout.write(`removed session at ${runtime.sessionPath}\n`);
    }
    process.stdout.write("restart the daemon to re-pair\n");
    return;
  }
  if (args.includes("--check-groups")) {
    const { groups } = loadConfig();
    process.stdout.write("Configured groups:\n");
    for (const [k, v] of Object.entries(groups)) {
      process.stdout.write(`  ${k.padEnd(22)} ${v.jid}  (label=${v.label})\n`);
    }
    return;
  }
  process.stdout.write(
    "infinity-whatsapp CLI\n" +
    "  --check-groups    print the four group JIDs from env\n" +
    "  --print-qr        wipe the WA session so the next start prints a fresh QR\n",
  );
}

main();
