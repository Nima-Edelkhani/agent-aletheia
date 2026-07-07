#!/usr/bin/env node
// Kills any running Aletheia dev processes.
//
// Usage: pnpm kill
//
// Hits three targets defensively:
//   1. Anything holding common Next.js dev ports (3000, 3001, 3002)
//   2. Any `next dev` process (regardless of port)
//   3. Any `scripts/setup.mjs` process (a stuck wizard)
//
// Uses SIGKILL so nothing can catch and refuse the signal.

import { execSync } from "node:child_process";

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
  red: (s) => `\x1b[31m${s}\x1b[39m`,
};

function shell(cmd) {
  try {
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function killPids(pids, label) {
  const unique = [...new Set(pids)].filter((p) => p && /^\d+$/.test(p));
  if (unique.length === 0) return 0;
  try {
    execSync(`kill -9 ${unique.join(" ")} 2>/dev/null || true`);
  } catch {
    /* best effort */
  }
  console.error(
    c.green(`  ✓ killed ${unique.length} ${label}: ${unique.join(", ")}`),
  );
  return unique.length;
}

console.error("");
console.error(c.bold("Aletheia — kill running dev processes"));
console.error(c.dim("─".repeat(36)));

let totalKilled = 0;

// 1. Free ports 3000, 3001, 3002 (Next.js dev fallbacks).
for (const port of [3000, 3001, 3002]) {
  const pids = shell(`lsof -ti :${port}`);
  totalKilled += killPids(pids, `process(es) on port ${port}`);
}

// 2. Any `next dev` process anywhere.
const nextPids = shell(`pgrep -f "next dev"`);
totalKilled += killPids(nextPids, "next dev process(es)");

// 3. Any stuck wizard.
const wizardPids = shell(`pgrep -f "scripts/setup.mjs"`);
totalKilled += killPids(wizardPids, "wizard process(es)");

// 4. Reset the terminal in case a killed process left it in raw mode.
// `stty sane` restores canonical (cooked) mode + normal echo + normal
// signal interpretation. Safe no-op if the terminal is already fine.
try {
  execSync("stty sane 2>/dev/null || true", { stdio: "inherit" });
} catch {
  /* best effort */
}

console.error("");
if (totalKilled === 0) {
  console.error(c.dim("  Nothing to kill — no running Aletheia processes found."));
} else {
  console.error(c.green(`  Done. Terminated ${totalKilled} process(es).`));
}
console.error("");
