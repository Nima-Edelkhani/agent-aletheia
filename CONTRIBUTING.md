# Contributing to Aletheia

Thanks for your interest. Aletheia is a small, focused project — I welcome contributions that fit the [philosophy in the README](./README.md#philosophy).

## Before you open a PR

1. **Discuss non-trivial changes first** — open an issue with the shape of what you're proposing before writing code. Small bug fixes and doc improvements don't need this.
2. **Run `pnpm ci`** — this is `pnpm typecheck && pnpm test`. CI runs the same. If it fails locally, it will fail in CI.
3. **Keep changes tight** — if your PR touches unrelated files "just to clean them up," pull that into a separate PR.
4. **Preserve invariants**:
   - Every emitted signal carries `reference_text` verbatim from the doc body.
   - `before_reference_text` / `after_reference_text` are cut deterministically from the real body, never trusted from the model.
   - `listMetadata()` never leaks the `body` field.
   - Sub-agents see ONE doc's metadata + body, never any other doc's.
   - The aggregate step's answer text carries an inline `[sN]` marker on every factual claim.
5. **Update docs together** — if you change the signal data model, update `PRD.md` AND the Signal shape table in `README.md` in the same PR.

## Local setup

```bash
git clone <your-fork>
cd aletheia
pnpm install
pnpm setup                          # seeds .env and knowledge-base/
# add your ANTHROPIC_API_KEY to .env
pnpm ci                             # verify baseline
```

## Where to make changes

- **Prompts** — orchestrator prompts live in `src/core/orchestrator.ts`; the sub-agent prompt lives in `src/core/subagent.ts`. If you tweak a prompt, run `pnpm evals:smoke` and compare aggregate scores before/after.
- **Signal shape / data model** — `src/core/types.ts`. Any change here ripples through `subagent.ts`, `signal-filter.ts`, `SignalCard.tsx`, the tests, and the README table.
- **Config knobs** — `config/thresholds.json` + the `AletheiaConfig` type. Add a comment above the new field explaining what it does.
- **Web UI** — `src/app/components/*` are Aletheia components. `src/components/ui/*` are shadcn primitives; don't hand-modify those (regenerate via the shadcn CLI). AI Elements (Task, Reasoning, PromptInput) come from `@ai-elements/…` — same rule.

## Testing

- `pnpm test` — vitest, 77 tests across 7 files. Add a test alongside every behavior change.
- `pnpm evals:smoke` — 3-question API-backed smoke test (~2 minutes, costs a few cents).
- `pnpm evals` — full 15-question golden set (~10 minutes).

## Commit style

Any commit message style is fine, but a short imperative subject line is preferred (e.g. `orchestrator: cache scoped metadata`). No conventional-commits prefix required.

## Publishing

I keep the `main` branch shippable. PRs go through CI. There's no separate release cadence — the tip of `main` is always the current version.

## Reporting security issues

**Do not open a public issue.** See [`SECURITY.md`](./SECURITY.md) for the private disclosure path.

## Code of Conduct

Be excellent to each other. Bad behavior gets you removed from the project without further notice.
