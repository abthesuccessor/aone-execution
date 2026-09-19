# aone-execution

**A local-first desktop workbench for graph engineering.** Describe what you
want once. It gathers context, proposes a graph of specialist agent nodes,
and waits. You review the plan, change anything, approve the exact bytes —
then it executes, and you can pause it mid-run, refine the plan, and continue.

Your code, your machine, your provider keys. Nothing leaves the laptop unless
you connect a hosted model and ask it to.

```
   idea ──▶ context ──▶ proposed graph ──▶ YOU APPROVE ──▶ execution
              ▲                                              │
              └──────── refine / replan ◀──── pause ◀─────────┘
```

---

## Why this exists

Most agent tools give you a chat box and a loop: one agent, one context, going
until it stops. That works until the task needs more than one kind of
attention — a researcher *and* a writer *and* a reviewer who is allowed to say
no.

[Graph engineering](https://www.aibuilderclub.com/blog/graph-engineering-guide-2026)
is the layer above that loop. Three parts:

| | |
|---|---|
| **Nodes** | units of work — a specialist agent, or a deterministic step. One responsibility each. |
| **Edges** | how work routes between them: sequential, conditional, fan-out, fan-in. |
| **Shared state** | the object that travels along the edges and accumulates as it goes. |

A loop is just a single-node graph with an edge back to itself. Graphs don't
replace loops; they sit above them.

This repository takes that idea seriously enough to make it **inspectable and
interruptible**. The graph is not an implementation detail hidden inside a
framework — it is the document you edit, the thing you approve by hash, and the
thing you watch execute.

> **The honest version:** most tasks only need a loop. Reach for a graph when
> the work genuinely splits into specializations with hand-offs. This tool is
> for when it does.

---

## What it actually does

**1. One sentence in.** Create an intent node: a name, an objective, optional
context and source files.

**2. Context gathering.** Attach evidence — Markdown, text, CSV, JSON, YAML,
XLSX. It is stored as immutable content-addressed bytes, chunked with
provenance, and retrieved with deterministic BM25 + trigram search fused by
reciprocal-rank fusion. No embeddings service required.

**3. A proposed graph.** Your configured model proposes the specialist count,
semantic domains, node objectives, agent assignments, typed input/output ports,
acceptance criteria, dependencies, and relationships. The canvas lays it out
with a force simulation; drag anything.

**4. You decide.** Inspect every node, its acceptance criteria, budgets, stop
conditions, agent prompt digests, and evidence pins. Change what you like.
Nothing runs yet.

**5. Approval by content hash.** You approve *exact plan content*, not a vague
intent. Change the draft, the skills, an agent prompt, the provider profile, or
the workspace baseline, and the approval is void — replan.

**6. Execution with a real stop button.**

- **Pause after current node** lets the in-flight node reach its checkpoint.
- **Breakpoints** pause *before* a chosen node starts.
- **Resume** continues the pinned plan.
- Or edit the draft, approve a replacement, and continue through a
  lineage-linked successor.
- **Cancel** interrupts the running process. Partial file edits stay for
  inspection — they are not silently rolled back.

**7. Refine anything, anytime.** Discuss, Refine, Fact-check, or Develop against
selected nodes. Proposed edits are reviewed before Apply, and Apply creates a
new draft revision — it never executes code or approves a plan.

### Edges carry meaning, not just order

`REQUIRES` orders execution. `SUPPORTS`, `CONTRADICTS`, `REFINES`, and
`RELATED_TO` are semantic — they inform review and retrieval without forcing a
sequence. Dependency cycles are rejected; semantic links may form any shape.

---

## It built something real

`generated/frame-infinite-gallery/` is a Vite + React + strict-TypeScript
gallery app — 120 deterministic artworks, local paging, search, saved views,
validated bookmark persistence — generated from **one idea node**, finishing
with an accepted PASS receipt.

The [trial record](docs/frame-generation-trial.md) is deliberately unflattering:
it documents that dependency setup and receipt recovery needed operator
intervention. It demonstrates a useful MVP, not unattended generation.

---

## Quickstart

**Requirements:** macOS (Apple Silicon verified), **Node.js 24**, Rust (for the
desktop build), and `python3` if you want the built-in terminal.

```sh
nvm use 24
npm ci
npm run desktop:start
```

Build a real installer:

```sh
npm run desktop:make:dmg
```

The DMG lands in `apps/desktop/src-tauri/target/release/bundle/dmg/`. It is
ad-hoc signed — fine locally; trusted distribution needs an Apple Developer ID
signature and notarization.

> **On Node versions:** every `package.json` pins `>=24 <25`, and Node 24 is the
> only version this project is verified on. The pin is advisory rather than
> enforced (`engine-strict` is off), so Node 22 installs with `EBADENGINE`
> warnings and most things work — but `npm run storage:import-sqlite` needs
> `node:sqlite`, and nothing on 22 is tested. Use 24.

The packaged app embeds its React UI and a loopback-only Node + PostgreSQL
engine sidecar. No browser, no external Node, no Docker.

---

## Configure a provider

Everything is bring-your-own. Open **Settings**:

| Provider | Plan | Execute | Notes |
|---|:--:|:--:|---|
| **Codex CLI** | ✅ | ✅ | The only workspace-write executor. `codex login`, then connect. |
| **OpenAI API** | ✅ | ❌ | Session key or `OPENAI_API_KEY`. |
| **Anthropic API** | ✅ | ❌ | Session key or environment credential. |
| **Ollama** | ✅ | ❌ | Loopback endpoint only — fully offline planning. |
| `simulation` | test | test | Deterministic fixtures. Disabled for real proposals. |

Hosted keys are masked and held **only in the running engine's memory**. They
are never written to PostgreSQL, plans, events, logs, or renderer storage.

Connecting a chat provider does **not** grant file execution. That requires the
Codex CLI adapter, explicitly.

---

## Memory and context efficiency

**Harness → Memory** keeps decisions and AI-proposed candidates locally in
PostgreSQL. A candidate must be confirmed before it can ever be recalled. Every
entry carries validation state and provenance; when its sources change it goes
stale rather than silently lying to you.

Context compaction is **bounded and extractive** — it keeps message references
and leaves the original transcript intact. Nothing is summarized away.

Optional [Hindsight](https://github.com/hindsight-ai/hindsight) and mem0 OSS
REST adapters are available. Remote recall is off unless enabled, records are
sent only with a per-record action, and remote results can *rank* local records
but can never introduce unreviewed text as accepted memory. Forgetting locally
excludes a record from recall but may leave a remote copy — the UI says so.

Output-style compression adapts the MIT-licensed
[Caveman](https://github.com/juliusbrussee/caveman) skill
([provenance](third_party/caveman/PROVENANCE.json)). It is guidance, not a
proven saving: provider usage remains the only consumption record.

---

## Agent coordination

Chat runs three bounded stages on **LangGraph** — brief → specialist review →
composition. Agents exchange explicit summaries, decisions, assumptions,
questions, and alternatives, and you can expand any response to inspect the
hand-offs, usage estimates, cached stages, and context pins. **Stop** interrupts
the current stage; **Resume saved stages** reuses completed checkpoints while
their context is still current.

This is structured state hand-off between stages, not a distributed agent
messaging protocol. Twelve agent archetypes span seven engineering departments,
all editable as versioned, digest-linked catalogs with optimistic concurrency.
Plans pin the effective configuration and reject later drift.

---

## Skills

The workbench routes skill packages (`SKILL.md` + references) into agent and
node context. **The catalog is not shipped in this repository** — those packages
belong to their authors, and redistributing them under this repo's licence is
not ours to do.

Build your own from skills you already have:

```sh
npm run skills:ingest
npm run skills:verify
```

Ingestion is transactional, digest-pinned, and refuses to shrink an existing
catalog by half or more without `EGE_SKILLS_ALLOW_SHRINK=1`. See
[docs/SKILL-CATALOG.md](docs/SKILL-CATALOG.md). The app runs fine with no
catalog at all.

---

## Observability

**Traces** is a local, PostgreSQL-backed explorer modeled on the
[OpenTelemetry](https://opentelemetry.io/docs/concepts/signals/traces/)
trace/span/event hierarchy, receiving replayable SSE while planning or
executing. Inspect the causal span tree, node and agent assignment, bounded
redacted requests, observed commands and exit codes, verification receipts,
artifacts, errors, and durations.

Captured documents are recursively redacted and size-bounded. Credentials,
authorization headers, cookies, private keys, and environment contents are never
intentional trace fields. It shows **observed activity only** — no hidden
chain-of-thought, and no model/tool/token/cost claims the provider did not
report.

No Docker, Langfuse, Grafana, or network service required.

---

## Architecture

- [Canonical architecture](docs/ARCHITECTURE.md) — authority model, invariants,
  diagrams, 17-chapter index.
- [Requirements traceability](docs/REQUIREMENTS-TRACEABILITY.md)
- [Normative contracts](docs/contracts/README.md) — GraphSpec and
  execution-history JSON Schema, OpenAPI, AsyncAPI, runtime/sandbox Protobuf.
- [Harness ADR](docs/adr/0001-engineering-harness.md)
- [Version policy](versions.lock) — evidence required before a release may be
  marked deployable.

This repository holds **two different things**: a production-oriented
architecture blueprint for a distributed platform, and a bounded single-user
desktop workbench that implements a genuinely useful slice of it. The desktop
app is real software. It is not the distributed platform the blueprint
describes.

---

## Development

```sh
npm run test:local        # server + workbench suites
npm run build:workbench
npm run validate          # contract gates (needs python3, redocly, buf)
npm run check             # everything, including cargo
```

`npm run dev` starts the old browser/Vite path. It is a developer diagnostic,
not the product surface.

---

## Honest boundary

Real, working, and tested: a single-user Tauri workbench with a compact dark IDE
layout, versioned editable catalogs, scoped AI chat with review-before-apply,
typed graph editing, configurable node execution, a loopback Node sidecar,
PostgreSQL, content-addressed evidence, several planning adapters, a Codex CLI
workspace adapter, a Python-backed local PTY, durable execution events, and a
local trace explorer.

Not implemented: identity, tenant isolation, distributed workers, HA, disaster
recovery, production observability.

**Known open issues**, carried deliberately rather than quietly:

- **The loopback HTTP API has no client authentication.** `/api/session`
  returns `auth: none`. Another local OS account able to reach loopback and set
  the right headers can drive the engine. Documented in the
  [readiness review](docs/production-readiness-review-2026-09-13.md) (S1) and
  still open.
- The Codex adapter uses the CLI's `workspace-write` sandbox — **not** container
  or VM isolation. Review and back up important work before running it.
- Approval is a workflow checkpoint, not authentication or authorization. The
  app has no account, login, role, or session-token layer.
- Fact-check results are AI assessments of attached excerpts. A citation's
  presence does not prove the model read it correctly.

Tests, a successful build, browser behavior, provider connectivity, and a
completed live execution each establish their own evidence. None proves the
others.

---

## License

[MIT](LICENSE) © Amarjargal Batbayar

Vendored third-party material is attributed with upstream commits and SHA-256
pins under [`third_party/`](third_party/). Skill packages are not redistributed
— see [docs/SKILL-CATALOG.md](docs/SKILL-CATALOG.md).
