# Security policy

## Supported versions

Aletheia is in early development. Only the `main` branch is currently supported.

## Reporting a vulnerability

Please **do not open a public issue** for anything that looks like a security concern. Instead, open a private security advisory via GitHub:

1. Go to the repository's **Security** tab
2. Click **Report a vulnerability**
3. Describe the issue with reproduction steps

You'll get an acknowledgement within a few days. Realistic fix timelines depend on the class of issue, but I aim to publish a fix or workaround within two weeks of confirmed reproduction, with credit if you'd like it.

## Threat model

Aletheia is designed to run **locally** against your own knowledge base. It talks to Anthropic's API using **your** key, which never leaves the machine it's set on except in the outbound HTTPS call to `api.anthropic.com`.

**In scope**

- Injection or code-execution vulnerabilities in the CLI, Next.js web UI, orchestrator, or sub-agent path
- Cross-doc leakage where a sub-agent could see a doc it shouldn't
- Prompt-injection in the knowledge-base docs that causes the sub-agent to leak sensitive data outside a signal, escalate tool access, or execute an unintended tool
- Any way an untrusted knowledge-base doc, XML file, or markdown frontmatter can trigger code execution on the host
- Path traversal in the knowledge-base loader or CLI `--extract` file argument
- Cache / config poisoning
- Dependency vulnerabilities that materially affect Aletheia's behavior

**Out of scope**

- Exhausting your own Anthropic API budget by asking too many expensive questions (this is a rate-limit / spend-control issue at the API level; use Anthropic's org spend limits)
- The sub-agent returning a wrong answer that grounds in a real quote — Aletheia optimizes for *verifiability*, not correctness. That's why every signal carries `reference_text` and a 3-check judge verdict for you to inspect
- Feature requests (open a public issue for those)

## What Aletheia does NOT do

- No telemetry, analytics, or crash reporting
- No network calls other than to `api.anthropic.com` (for the LLM) and to Google Fonts on the web UI (via `next/font/google`)
- No persistent storage of your questions or answers beyond the `evals/report/` folder (which is gitignored) and any file you explicitly write to with `--out`
- No hidden API keys, no default cloud endpoints, no auto-updates

## Handling your API key

Your `ANTHROPIC_API_KEY` lives in `.env` at the repo root. `.env` is gitignored — you cannot accidentally commit it via `git add .`. Nothing in the codebase reads the key except the Anthropic SDK and the Claude Agent SDK. Rotate the key at [console.anthropic.com](https://console.anthropic.com) if you ever paste output containing it (the `--debug` flag does NOT print the key, but be careful with generic terminal recordings).

## Handling untrusted knowledge-base docs

Files dropped into `knowledge-base/` are treated as **data**, not instructions. The sub-agent's system prompt is written to resist prompt injection ("emit `no_signal` if the body does not affirmatively answer the question", "reference_text must be a verbatim quote"), and it operates with `settingSources: []` so no filesystem tools are available inside a sub-agent turn. That said, prompt injection is an unsolved problem in LLM systems generally — if you're loading docs from an untrusted source, review the response and the trace's `dropped_signals` before acting on the answer.
