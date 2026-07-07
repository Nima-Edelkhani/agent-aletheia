#!/usr/bin/env node
// Aletheia first-run setup.
//
// Non-interactive steps (always run):
//   1. Copy .env.example → .env if .env is missing.
//   2. Seed knowledge-base/ from examples/voxly-corpus/ if empty.
//
// Interactive steps (only when stdin is a TTY):
//   3. If ANTHROPIC_API_KEY is missing or placeholder in .env, print the
//      exact line the user needs to add, then wait for them to save it
//      themselves. We never accept the key via prompt — it belongs in .env.
//   4. Verify the key with a 1-token test call.
//   5. Offer to launch the web UI (pnpm dev).
//
// Idempotent — safe to run repeatedly.

import { readdir, copyFile, access, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const ENV_PATH = join(ROOT, ".env");

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
  red: (s) => `\x1b[31m${s}\x1b[39m`,
  cyan: (s) => `\x1b[36m${s}\x1b[39m`,
};

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirEmpty(path) {
  try {
    const entries = await readdir(path);
    return entries.filter((e) => !e.startsWith(".")).length === 0;
  } catch {
    return true;
  }
}

async function ensureEnv() {
  const examplePath = join(ROOT, ".env.example");
  if (await exists(ENV_PATH)) {
    console.error(c.dim("· .env already present — leaving it alone."));
    return;
  }
  if (!(await exists(examplePath))) {
    console.error(c.yellow("! .env.example missing; skipping .env creation."));
    return;
  }
  await copyFile(examplePath, ENV_PATH);
  console.error(c.green("✓ .env created from .env.example."));
}

async function ensureKnowledgeBase() {
  const kbDir = join(ROOT, "knowledge-base");
  const corpusDir = join(ROOT, "examples/voxly-corpus");
  await mkdir(kbDir, { recursive: true });

  if (!(await isDirEmpty(kbDir))) {
    console.error(
      c.dim("· knowledge-base/ already has docs — leaving them in place."),
    );
    return;
  }
  if (!(await exists(corpusDir))) {
    console.error(c.yellow("! examples/voxly-corpus missing; skipping KB seed."));
    return;
  }
  const files = (await readdir(corpusDir)).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    await copyFile(join(corpusDir, file), join(kbDir, file));
  }
  console.error(
    c.green(`✓ Seeded knowledge-base/ with ${files.length} Voxly docs.`),
  );
}

/**
 * Read the current ANTHROPIC_API_KEY value from .env.
 * Returns "" if the file or the line is missing.
 * Placeholder values ("sk-ant-..." or empty) come back as "".
 */
async function readApiKeyFromEnv() {
  try {
    const raw = await readFile(ENV_PATH, "utf8");
    const line = raw
      .split("\n")
      .find((l) => l.trim().startsWith("ANTHROPIC_API_KEY="));
    if (!line) return "";
    const value = line.split("=", 2)[1]?.trim() ?? "";
    if (!value || value.startsWith("sk-ant-...") || value.length < 20) return "";
    return value;
  } catch {
    return "";
  }
}

async function verifyKey(key) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  if (resp.ok) return { ok: true };
  const body = await resp.text().catch(() => "");
  if (resp.status === 401) {
    return { ok: false, reason: "authentication failed — key is not valid" };
  }
  if (resp.status === 402 || body.includes("credit balance")) {
    // Key is valid; account just needs credits. Treat as pass so setup can
    // finish; the user will hit the credit error when they actually ask.
    return { ok: true, warning: "key is valid but account is out of credits" };
  }
  return { ok: false, reason: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
}

async function interactiveKeyWait(rl) {
  console.error("");
  console.error(c.bold("Add your Anthropic API key"));
  console.error(c.dim("─".repeat(28)));
  console.error(`Open ${c.cyan(ENV_PATH)} in your editor and add:`);
  console.error("");
  console.error(`  ${c.bold("ANTHROPIC_API_KEY=sk-ant-your-key-here")}`);
  console.error("");
  console.error(
    c.dim(
      "Get a key at https://console.anthropic.com/settings/keys. " +
        "The wizard never sees or stores your key — it stays in .env only.",
    ),
  );
  console.error("");

  while (true) {
    await rl.question(c.dim("Press Enter once you've saved .env… "));
    const key = await readApiKeyFromEnv();
    if (!key) {
      console.error(
        c.yellow(
          "! Still no ANTHROPIC_API_KEY in .env — make sure the line starts with ANTHROPIC_API_KEY= and the value is present.",
        ),
      );
      continue;
    }
    process.stderr.write(c.dim("Verifying key with Anthropic… "));
    const verdict = await verifyKey(key);
    if (verdict.ok) {
      console.error(c.green("✓"));
      if (verdict.warning) console.error(c.yellow(`  ! ${verdict.warning}`));
      return;
    }
    console.error(c.red(`✗ ${verdict.reason}`));
    console.error(c.dim("  Fix the key in .env and press Enter again."));
  }
}

async function offerLaunch(rl) {
  console.error("");
  console.error(c.bold("How would you like to run Aletheia?"));
  console.error(c.dim("─".repeat(36)));
  console.error("");
  console.error(`  ${c.cyan("[1]")} ${c.bold("Web UI")}   ${c.dim("— launches pnpm dev, opens http://localhost:3000")}`);
  console.error(`  ${c.cyan("[2]")} ${c.bold("CLI")}      ${c.dim("— prints example commands you can copy-paste")}`);
  console.error(`  ${c.cyan("[q]")} Quit`);
  console.error("");

  let choice = "";
  while (true) {
    const raw = (await rl.question(c.dim("Choose 1, 2, or q: "))).trim().toLowerCase();
    if (raw === "1" || raw === "ui" || raw === "web") { choice = "ui"; break; }
    if (raw === "2" || raw === "cli") { choice = "cli"; break; }
    if (raw === "q" || raw === "quit" || raw === "exit") { choice = "quit"; break; }
    console.error(c.yellow("  ! Please enter 1, 2, or q."));
  }

  if (choice === "cli") {
    printCliExamples();
    return;
  }
  if (choice === "quit") {
    console.error("");
    console.error(c.dim("You can start Aletheia later with:"));
    console.error(`  ${c.cyan("pnpm start")}  ${c.dim("— re-open this menu")}`);
    console.error(`  ${c.cyan("pnpm dev")}    ${c.dim("— jump straight to the web UI")}`);
    console.error(`  ${c.cyan("pnpm aletheia ask \"…\"")}  ${c.dim("— run a single query from the CLI")}`);
    console.error("");
    return;
  }

  // choice === "ui"
  // Bypass pnpm entirely — pnpm 11 does not reliably forward SIGINT to its
  // child, so `spawnSync("pnpm", ["dev"])` leaves the dev server unkillable
  // via Ctrl+C. Running the local `next` binary directly puts next dev in
  // the terminal's foreground process group with no intermediary, so Ctrl+C
  // hits it directly and shuts it down cleanly.
  rl.close();

  // CRITICAL: readline puts the TTY into raw mode while active and is meant
  // to restore it on close. In practice Node sometimes leaves stdin in raw
  // mode, which means the terminal driver treats Ctrl+C as a literal 0x03
  // byte instead of firing SIGINT — the user hits Ctrl+C and sees "^C"
  // echoed while the dev server keeps running. Force the TTY back to
  // cooked (canonical) mode before handing control to next dev.
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* not fatal — best effort */
    }
  }

  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  const nextBin = join(ROOT, "node_modules", ".bin", "next");
  console.error("");
  console.error(c.cyan("Starting the dev server — press Ctrl+C to stop."));
  console.error(
    c.dim("  (If Ctrl+C won't kill it, open another terminal and run: ") +
      c.cyan("pnpm kill") +
      c.dim(")"),
  );
  const result = spawnSync(nextBin, ["dev"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.signal) {
    process.exit(result.signal === "SIGINT" ? 130 : 1);
  }
  process.exit(result.status ?? 0);
}

function printCliExamples() {
  console.error("");
  console.error(c.bold("CLI quickstart"));
  console.error(c.dim("─".repeat(14)));
  console.error("");
  console.error(c.dim("Ask a question against the seeded Voxly corpus:"));
  console.error(
    `  ${c.cyan("pnpm aletheia ask")} ${c.dim(
      '"What did customers discuss in the past month?"',
    )}`,
  );
  console.error(
    `  ${c.cyan("pnpm aletheia ask")} ${c.dim(
      '"Which customers raised pricing concerns in the past 3 months?"',
    )}`,
  );
  console.error(
    `  ${c.cyan("pnpm aletheia ask")} ${c.dim(
      '"What has Nimbus Health discussed across their meetings?"',
    )}`,
  );
  console.error("");
  console.error(c.dim("List every doc in the knowledge base:"));
  console.error(`  ${c.cyan("pnpm aletheia list-docs")}`);
  console.error("");
  console.error(c.dim("Handy flags:"));
  console.error(
    `  ${c.dim("--scope")}      ${c.dim("print every doc ID the filter step selected")}`,
  );
  console.error(
    `  ${c.dim("--expand")}     ${c.dim("render each signal as a full card")}`,
  );
  console.error(
    `  ${c.dim("--extract '<schema>'")} ${c.dim(
      "typed extraction — every signal also fills a payload matching the schema",
    )}`,
  );
  console.error(
    `  ${c.dim("--out <path>")} ${c.dim("write the full response + trace JSON to disk")}`,
  );
  console.error("");
  console.error(
    `${c.dim("Full flag list:")} ${c.cyan("pnpm aletheia ask --help")}`,
  );
  console.error("");
  console.error(
    `${c.dim("Later, launch the web UI anytime with:")} ${c.cyan("pnpm dev")}`,
  );
  console.error("");
}

function printNextSteps(keyOk) {
  console.error("");
  console.error(c.bold("Next steps"));
  console.error(c.dim("─".repeat(10)));
  if (!keyOk) {
    console.error(
      `  1. ${c.bold("Add your Anthropic API key")} to ${c.cyan(".env")}:`,
    );
    console.error(`     ${c.dim("ANTHROPIC_API_KEY=sk-ant-your-key-here")}`);
    console.error("");
    console.error(`  2. Ask a question:`);
  } else {
    console.error(`  1. Ask a question:`);
  }
  console.error(
    `     ${c.cyan("pnpm aletheia ask")} ${c.dim(
      '"What did customers discuss in the past month?"',
    )}`,
  );
  console.error("");
  console.error(`  ${keyOk ? "2" : "3"}. Or launch the web UI:`);
  console.error(
    `     ${c.cyan("pnpm dev")} ${c.dim("# then open http://localhost:3000")}`,
  );
  console.error("");
}

async function main() {
  console.error(c.bold("\nAletheia — first-run setup\n"));
  await ensureEnv();
  await ensureKnowledgeBase();

  const initialKey = await readApiKeyFromEnv();
  const interactive = process.stdin.isTTY && !process.env.ALETHEIA_SETUP_NONINTERACTIVE;

  if (initialKey) {
    process.stderr.write(c.dim("Verifying existing .env key with Anthropic… "));
    const verdict = await verifyKey(initialKey);
    if (verdict.ok) {
      console.error(c.green("✓"));
      if (verdict.warning) console.error(c.yellow(`  ! ${verdict.warning}`));
      if (interactive) await offerLaunch(rlFor());
      else printNextSteps(true);
      return;
    }
    console.error(c.red(`✗ ${verdict.reason}`));
  }

  if (!interactive) {
    printNextSteps(false);
    return;
  }

  await interactiveKeyWait(rlFor());
  await offerLaunch(rlFor());
}

let _rl;
function rlFor() {
  if (!_rl) _rl = createInterface({ input: process.stdin, output: process.stderr });
  return _rl;
}

main()
  .catch((err) => {
    console.error("Setup failed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Close readline unconditionally so stdin releases and Node exits
    // instead of hanging at the terminal after the wizard finishes.
    if (_rl) _rl.close();
  });
