# Required cross-node review

A target node can require selected graph nodes to review its recorded execution evidence before its checkpoint is accepted and dependent work starts. The normal `REQUIRES` DAG controls execution order. `VERIFIES` remains a semantic relationship; it neither invokes review automatically nor grants execution authority.

The optional draft-node contract is:

```json
{
  "review": {
    "required": true,
    "reviewerNodeIds": ["quality-reviewer"],
    "providerId": "ollama"
  }
}
```

The configuration schema is `apps/local-server/src/node-review.schema.json`. Omission disables the gate. A disabled configuration can retain its selected IDs without making provider calls. An enabled configuration requires one to four distinct existing graph-node IDs and cannot reference the target itself. Set the review provider separately from the nodes' ordinary execution providers. This allows Codex to implement the graph while an API model reviews the recorded results.

Each selected reviewer needs an active agent preset. When no preset is explicitly selected, an unambiguous generated specialist assignment can supply it. Ambiguous assignments fail planning with an actionable configuration error. The supported review transports are OpenAI API, Anthropic API and Ollama. These transports receive messages with no tool definitions. Codex CLI is excluded from review because a read-only filesystem sandbox still permits command execution and file inspection.

## Approval and bounded execution

The plan pins the review configuration, reviewer node configuration, agent prompt and policy/configuration digests, provider profile and connection revision, model, and engineering settings revision. These pins contribute to the target step's input digest and the immutable plan content hash. Changes invalidate approval or the pending review. Engineering settings are checked before each node; reviewer pins are checked before and after every model response.

After the target executor produces an accepted result, the harness creates a bounded review packet from its observed successful command outputs and captured changed-file artifacts. The packet contains at most 32 excerpts, 6,000 characters per excerpt and 48,000 characters total. Truncation and content digests remain visible. The executor's self-reported acceptance assertion is not a substitute for these excerpts.

Each reviewer makes one sequential API call with a 60-second timeout, a 6,000-output-token request and a 48,000-character response bound. A timeout, cancellation, provider failure, malformed output, stale pin or output overflow blocks acceptance. There is no automatic review retry. A failure stops the remaining reviews and prevents dependent execution. Reviewers never recursively invoke their own configured reviewers; even mutual review assignments remain a bounded list of isolated calls.

Every approved acceptance criterion must appear exactly once in its original order. A supported assessment requires `support: "recorded_evidence"` and valid evidence IDs with matching verbatim quotations. Invented references, mismatched quotations and inferred support become `insufficient_evidence`. Contradictory or insufficient results block the gate. Simulated execution cannot satisfy a required recorded-evidence review.

An accepted gate completes the target checkpoint through the existing atomic `completeNode` path. A blocked gate uses the durable failed-node path and leaves dependent nodes unstarted. The verification receipt preserves `executionResult` separately from the aggregate `result`, plus review evidence, reviewer/model identities, criterion assessments, citations, errors and configuration digest. Existing receipts are not rewritten. `node.review.started`, `node.review.completed` and `node.review.blocked` events describe review progress. User cancellation retains the cancellation state and ignores a late model response.

## What this establishes

A passing review means a configured AI reviewer assessed the supplied recorded evidence as supporting the criteria, with citations whose IDs and quotations were mechanically checked. It does not independently prove the review's semantic judgment, full source correctness, unobserved tests, current external facts or production behavior. Excerpts can omit relevant files. The reviewer is instructed to block when those gaps matter. Run independent tests and human review where the risk requires them.

Automated tests cover configuration validation, isolated API transport selection, mutual-reference boundedness, valid and invalid citations, inference rejection, missing evidence, timeout, cancellation, stale pins, output bounds, and durable dependent-task admission. Controlled provider responses exercise the contract; they do not establish live model review quality.
