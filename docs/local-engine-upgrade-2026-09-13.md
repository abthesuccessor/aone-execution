# Native PostgreSQL and engineering controls

This upgrade implements native embedded PostgreSQL storage, a pinned MIT Caveman skill adaptation, a Skills & engineering settings window, and required cross-node review during sequenced execution. It targets the local desktop workbench. It does not establish hosted production readiness or remediate every finding in the earlier [production review](production-readiness-review-2026-09-13.md).

## Storage and existing data

All running application stores now use native PostgreSQL: graphs, draft and plan revisions, approvals, executions, events, receipts, evidence metadata, agent/catalog revisions, provider profiles, conversations, harness checkpoints/cache, memory, compactions, and engineering settings. Source object bytes remain in the existing content-addressed object directory. SQLite is used only by the explicit, offline legacy importer. There is no SQLite runtime fallback.

The engine owns a PostgreSQL process, its private data directory, a worker connection, and a guardian process. It uses a private Unix socket, SCRAM credentials in a restricted local file, filesystem permissions, durable commits, bounded statement/lock waits, and an exclusive owner lock. The guardian closes the owned database after engine death; a recovery guard prevents a second owner from attaching while the old PostgreSQL process is alive. Transaction callbacks continue using one connection through the worker adapter. This preserves the application's existing transaction boundaries, but synchronous callers can still block the Node event loop while waiting for the worker.

The default state directory is `.ege/postgres`, or `engine-data/postgres` beneath the Tauri application-data directory. `EGE_DATABASE_PATH` now identifies a directory. `:memory:` creates a disposable native PostgreSQL cluster for tests; it is not an in-memory SQLite database. The `startEmbeddedLocalServer` helper defaults to `state/postgres` beneath its `dataDir`.

An existing sibling `local.db` prevents opening an apparently empty replacement store until import has completed. Automated tests used disposable databases. After verifying that the existing development and desktop SQLite stores were closed, this run explicitly imported both stores: development preserved 2 graphs across 163 rows in 15 tables and one source object; desktop preserved 1 graph across 188 rows in 15 tables. Both original SQLite files remain intact. The adjacent PostgreSQL directories contain import manifests with per-table verification digests. Installed application binaries were not replaced.

Stop the old application before importing. From the repository root, supply the actual source and destination paths:

```sh
npm run storage:import-sqlite -- \
  --source "/absolute/path/to/engine-data/local.db" \
  --destination "/absolute/path/to/engine-data/postgres"
```

The importer opens SQLite read-only, checks integrity and foreign keys, requires an empty PostgreSQL destination, preserves ordered history, and verifies row counts and per-table content digests before committing. It copies and verifies source objects, preserves the original database, and writes `sqlite-import-manifest.json`. Unsupported tables or columns fail explicitly. The durable database import record permits safe republication of the completion marker if a crash occurred between commit and marker creation. A repeated import does not overwrite newer PostgreSQL rows.

If object storage is elsewhere, also supply `--source-object-root` and `--destination-object-root`. Project working files are external to this migration. Preserve them separately. The importer is a migration mechanism; it is not an automated backup or disaster-recovery service.

With the owning application running, inspect its cluster using an installed `psql` client:

```sh
npm run storage:psql -- \
  --data-dir "/absolute/path/to/engine-data/postgres" \
  -- -X -c "SELECT current_setting('server_version'), current_setting('listen_addresses'), current_setting('fsync');"
```

The helper reads the private runtime metadata and uses a temporary restricted password file. It does not print the password. Set `EGE_PSQL_PATH` to select a specific installed client. The desktop package includes the server binaries; it does not install a global `psql` executable.

The pinned native distribution is `embedded-postgres@18.4.0-beta.17`, containing PostgreSQL 18.4. PostgreSQL currently lists 18.6 and recommends the current minor release; qualification of an updated embedded binary is a release requirement. [PostgreSQL version policy](https://www.postgresql.org/support/versioning/), [embedded distribution](https://github.com/leinelissen/embedded-postgres).

## pgvector and HNSW

The current local retrieval path uses lexical ranking and reviewed memory provenance. It has no configured embedding model or vector corpus. This upgrade therefore creates neither vector columns nor HNSW indexes. The pinned binary distribution does not include pgvector, and health metadata reports that limitation explicitly.

Introduce pgvector when semantic retrieval is an actual requirement: pin an embedding model and dimension, define the source/digest and scope of every vector, make vectors rebuildable projections, evaluate recall against representative queries, and measure latency. Start with exact search; choose HNSW only when measured scale and recall justify its additional memory, build time, and approximate results. [pgvector documentation](https://github.com/pgvector/pgvector).

## Skills, harness, memory, and context

Open **Skills & engineering** from the Skills catalog, Settings, or command palette. The window provides four tabs:

| Tab | Effective control |
| --- | --- |
| Skills | Search installed/catalog skills and disable or re-enable their use. Existing catalog enable/archive state remains distinct. |
| Harness | Select Caveman Off, Lite, Full, or Ultra for model output prose. Existing per-graph harness profiles and token budgets remain available in Harness. |
| Memory | Permit or suppress reviewed memory recall into prompts, including optional remote recall. Stored records remain available for review. |
| Context | Enable conversation compaction and set a 4,000–200,000 character context budget. The default is 48,000. |

Settings persist in PostgreSQL with a revision and compare-and-swap save. A concurrent edit preserves the current window's unsaved choices and requires reload before saving. Disabled automatic skills are excluded; explicitly assigned disabled skills produce an actionable error so instructions are never silently removed. Settings revisions enter plan and harness identity. Changing controls requires a new plan/approval or harness run when existing pins become stale.

Ordinary chat selects complete preserved messages within its history allocation. Harness compaction uses attributable verbatim excerpts with source message digests and omission metadata. Original conversation records remain unchanged. When compaction is disabled, an oversized history fails visibly instead of being silently shortened. Complete selected skill instructions remain subject to their 128 KiB combined limit and the configurable context limit; increase the context budget or narrow the selection when necessary.

## Caveman integration and proof of savings

The upstream Caveman repository has a split license. Its skill is MIT; its compression engine/proxy are BSL. This implementation vendors the MIT skill, license, licensing map, commit, and checksums in [third_party/caveman](../third_party/caveman/PROVENANCE.json), and adapts the prose guidance in [token_policy.mjs](../apps/local-server/src/token_policy.mjs). It contains no upstream BSL engine, proxy, telemetry, or installer. [Upstream licensing](https://github.com/juliusbrussee/caveman/blob/15581d14007fd01fb3f132016741962f34936ca2/LICENSING.md).

The small policy is used by planning, chat, harness stages, execution explanations, and node-review summaries. It preserves technical substance, uncertainty, negation, numbers, units, language, citations, exact code/commands/paths, acceptance criteria, structured keys, receipts, and persisted document text. Full source provenance stays in stored pins rather than being repeated in every model prompt.

Caveman is output-style guidance. It is separate from input-context selection. The policy itself adds input tokens; terse output can reduce output tokens. Actual net savings require a matched baseline with the same task, model, evidence, and acceptance checks. Provider usage remains the consumption record; character-based instruction estimates are labeled estimates. No fixed saving or live-model quality improvement was established by this implementation's controlled-provider tests.

## Cross-node fact-checking during execution

In a target node's configuration, select **Require cross-node fact-check**, one to four reviewer nodes, and a connected OpenAI API, Anthropic API, or Ollama review provider. Each reviewer needs an active agent preset. The review provider is separate from normal execution, so Codex can execute the node while an API model reviews its recorded result.

The scheduler still follows `REQUIRES`. After the target executor produces an accepted result, the gate sends bounded observed command outputs and captured artifacts to each reviewer sequentially. Every acceptance criterion must be assessed with known evidence IDs and matching verbatim quotations. All required reviewers must pass before the target checkpoint is accepted and dependent tasks start. Insufficient evidence, contradiction, malformed output, missing evidence, timeout, cancellation, stale configuration, or workspace drift blocks admission and preserves the review result in the receipt.

Mutual assignments are permitted without recursive calls. For example, A may select B's reviewer preset and B may select A's preset; neither assignment adds a scheduling dependency or invokes the other node's review gate. Each target has at most four review calls, one pass per reviewer, with a 60-second timeout per call. Simulation cannot satisfy a required recorded-evidence review.

This establishes a configured AI assessment of recorded excerpts. Citation matching proves attribution, not independent semantic correctness. Live model review quality still needs evaluation. See [the complete review contract](node-review.md) for failure behavior and evidence bounds.

## Validation and remaining release requirements

Automated coverage exercises native storage, transaction rollback, restart, import, guardian recovery, settings conflicts, context bounds, exact skill preservation, review admission/failure/cancellation/staleness, and ordinary application regressions. Desktop smoke testing launches the copied packaged Node runtime with bundled PostgreSQL resources. Browser checks use a disposable local PostgreSQL database. The final verification record is stored alongside [the UI evidence](reviews/2026-09-13-engineering-ui/verification.json).

Before production distribution, qualify the current PostgreSQL patch, complete native-library notices and source obligations, validate signed/notarized packaging on every supported target, exercise backup/restore with object storage, and address the earlier security/readiness findings. In particular, this change does not add application authentication to the loopback HTTP API. The native socket runtime currently supports macOS/Linux code paths; Windows is explicitly rejected, and this run validates macOS ARM64 only. No hosted deployment or real external-provider evaluation was performed.
