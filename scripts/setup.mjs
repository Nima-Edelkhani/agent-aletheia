#!/usr/bin/env node
// One-shot bootstrap for a fresh clone. Copies .env.example → .env, seeds
// knowledge-base/ with the sample Voxly corpus if empty, and prints next steps.
// Idempotent — safe to run repeatedly. Never overwrites an existing .env
// or existing knowledge-base contents.

import { readdir, copyFile, access, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const c = {
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
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
  const envPath = join(ROOT, ".env");
  const examplePath = join(ROOT, ".env.example");
  if (await exists(envPath)) {
    console.error(c.dim("· .env already present — leaving it alone."));
    return "existing";
  }
  if (!(await exists(examplePath))) {
    console.error(c.yellow("! .env.example missing; skipping .env creation."));
    return "skipped";
  }
  await copyFile(examplePath, envPath);
  console.error(c.green("✓ .env created from .env.example."));
  return "created";
}

async function ensureKnowledgeBase() {
  const kbDir = join(ROOT, "knowledge-base");
  const corpusDir = join(ROOT, "examples/voxly-corpus");
  await mkdir(kbDir, { recursive: true });

  if (!(await isDirEmpty(kbDir))) {
    console.error(
      c.dim(
        "· knowledge-base/ already has docs — leaving them in place.",
      ),
    );
    return "existing";
  }
  if (!(await exists(corpusDir))) {
    console.error(
      c.yellow("! examples/voxly-corpus missing; skipping KB seed."),
    );
    return "skipped";
  }
  const files = (await readdir(corpusDir)).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    await copyFile(join(corpusDir, file), join(kbDir, file));
  }
  console.error(
    c.green(`✓ Seeded knowledge-base/ with ${files.length} Voxly docs.`),
  );
  return "seeded";
}

function checkApiKey(envResult) {
  // Read .env to check whether ANTHROPIC_API_KEY looks set.
  // We don't touch the value; just report status.
  return import("node:fs").then(({ readFileSync }) => {
    try {
      const raw = readFileSync(join(ROOT, ".env"), "utf8");
      const line = raw
        .split("\n")
        .find((l) => l.trim().startsWith("ANTHROPIC_API_KEY="));
      if (!line) return "missing";
      const value = line.split("=", 2)[1]?.trim() ?? "";
      if (!value || value.startsWith("sk-ant-...") || value.length < 20) {
        return "placeholder";
      }
      return "set";
    } catch {
      return envResult === "created" ? "placeholder" : "missing";
    }
  });
}

function nextSteps(keyStatus) {
  console.error("");
  console.error(c.bold("Next steps"));
  console.error(c.dim("─────────"));
  if (keyStatus !== "set") {
    console.error(
      `  1. ${c.bold("Add your Anthropic API key")} to ${c.cyan(".env")}:`,
    );
    console.error(`     ${c.dim("ANTHROPIC_API_KEY=sk-ant-...")}`);
    console.error("");
    console.error(
      `  2. Ask a question via the CLI:`,
    );
  } else {
    console.error(`  1. Ask a question via the CLI:`);
  }
  console.error(
    `     ${c.cyan("pnpm aletheia ask")} ${c.dim('"Which customers raised pricing concerns in the last 3 months?"')}`,
  );
  console.error("");
  console.error(`  ${keyStatus === "set" ? "2" : "3"}. Or launch the web UI:`);
  console.error(`     ${c.cyan("pnpm dev")} ${c.dim("# then open http://localhost:3000")}`);
  console.error("");
  console.error(`  ${keyStatus === "set" ? "3" : "4"}. Run the evals:`);
  console.error(
    `     ${c.cyan("pnpm evals:smoke")} ${c.dim("# 3-question smoke test")}`,
  );
  console.error(
    `     ${c.cyan("pnpm evals")}       ${c.dim("# full golden set (15 questions)")}`,
  );
  console.error("");
}

async function main() {
  console.error(c.bold("\nAletheia — first-run setup\n"));
  const envResult = await ensureEnv();
  await ensureKnowledgeBase();
  const keyStatus = await checkApiKey(envResult);
  nextSteps(keyStatus);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
