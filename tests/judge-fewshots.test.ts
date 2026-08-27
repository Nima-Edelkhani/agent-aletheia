import { describe, it, expect, beforeEach } from "vitest";
import { resolve } from "node:path";
import {
  loadJudgeFewShots,
  renderJudgeFewShots,
  resetJudgeFewShotsCache,
} from "../src/core/judge-fewshots";

const REAL_PATH = resolve(process.cwd(), "config/judge-fewshots.json");

const REQUIRED_CHECKS = [
  "reference_supports_summary",
  "summary_addresses_question",
  "category_is_sensible",
];

describe("judge few-shots", () => {
  beforeEach(() => resetJudgeFewShotsCache());

  it("ships a file covering all three judge checks", async () => {
    const file = await loadJudgeFewShots(REAL_PATH);
    const checks = file.checks.map((c) => c.check);
    for (const required of REQUIRED_CHECKS) {
      expect(checks).toContain(required);
    }
  });

  it("gives every check at least one PASS and one FAIL example", async () => {
    const file = await loadJudgeFewShots(REAL_PATH);
    for (const block of file.checks) {
      const verdicts = block.examples.map((e) => e.verdict);
      expect(verdicts, `${block.check} needs a pass example`).toContain("pass");
      expect(verdicts, `${block.check} needs a fail example`).toContain("fail");
    }
  });

  it("requires the core fields on every example", async () => {
    const file = await loadJudgeFewShots(REAL_PATH);
    for (const block of file.checks) {
      for (const ex of block.examples) {
        expect(ex.rescoped_question).toBeTruthy();
        expect(ex.reference_text).toBeTruthy();
        expect(ex.finding_summary).toBeTruthy();
        expect(ex.finding_category).toBeTruthy();
        expect(ex.reason).toBeTruthy();
        expect(["pass", "fail"]).toContain(ex.verdict);
      }
    }
  });

  it("renders each check heading and its examples into the prompt fragment", async () => {
    const rendered = await renderJudgeFewShots(REAL_PATH);
    expect(rendered).toContain("Few-shot examples");
    for (const required of REQUIRED_CHECKS) {
      expect(rendered).toContain(`### Check: ${required}`);
    }
    // Both verdict labels should show up in the rendered text.
    expect(rendered).toContain("PASS");
    expect(rendered).toContain("FAIL");
  });

  it("degrades to an empty fragment when the file is missing", async () => {
    const rendered = await renderJudgeFewShots(
      resolve(process.cwd(), "config/does-not-exist.json"),
    );
    expect(rendered).toBe("");
  });
});
