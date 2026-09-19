import { randomUUID } from 'node:crypto';
import { PostgresDatabaseSync } from './postgres_sync.mjs';
import { captureTracePayload, createSpanId, createTraceId, sanitizeTracePayload, TRACE_SCHEMA_VERSION } from './trace_data.mjs';
import { createContentDigest } from './agents.mjs';

function timestamp() {
  return new Date().toISOString();
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function graphFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    workspacePath: row.workspace_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    draftRevision: Number(row.draft_revision ?? 0),
  };
}

function draftFromRow(row) {
  if (!row) return null;
  return {
    graphId: row.graph_id,
    revision: Number(row.revision),
    nodes: parseJson(row.nodes_json, []),
    edges: parseJson(row.edges_json, []),
    context: row.context,
    createdAt: row.created_at,
  };
}

function planFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    graphId: row.graph_id,
    version: Number(row.version_number),
    baseDraftRevision: Number(row.base_draft_revision),
    parentPlanId: row.parent_plan_id,
    provider: row.provider,
    status: row.status,
    contentHash: row.content_hash,
    instructions: row.instructions,
    plan: parseJson(row.plan_json, {}),
    diff: parseJson(row.diff_json, {}),
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    traceId: row.trace_id ?? null,
  };
}

function approvalFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    graphId: row.graph_id,
    planId: row.plan_id,
    decision: row.decision,
    rationale: row.context,
    approvedContentHash: row.approved_content_hash,
    createdAt: row.created_at,
  };
}

function executionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    graphId: row.graph_id,
    planId: row.plan_id,
    status: row.cancelled_at ? 'CANCELLED' : row.status,
    parentExecutionId: row.parent_execution_id,
    rootExecutionId: row.root_execution_id,
    resumedFromCheckpoint: parseJson(row.resumed_from_checkpoint_json, null),
    pendingPlanId: row.pending_plan_id,
    completedNodeIds: parseJson(row.completed_node_ids_json, []),
    currentNodeId: row.current_node_id,
    pauseRequested: Boolean(row.pause_requested),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    traceId: row.trace_id ?? null,
    workspacePath: row.workspace_path ?? null,
    workspaceBindingDigest: row.workspace_binding_digest ?? null,
    workspaceBaseline: parseJson(row.workspace_baseline_json, null),
    selectedNodeIds: parseJson(row.selected_node_ids_json, null),
    passedBreakpointNodeIds: parseJson(row.passed_breakpoint_node_ids_json, []),
    cancelledAt: row.cancelled_at ?? null,
  };
}

function traceFromRow(row) {
  if (!row) return null;
  const endedAt = row.ended_at ?? null;
  return {
    id: row.id,
    traceId: row.id,
    schemaVersion: Number(row.schema_version),
    graphId: row.graph_id,
    executionId: row.execution_id,
    planId: row.plan_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    rootSpanId: row.root_span_id,
    provider: row.provider,
    model: row.model,
    attributes: parseJson(row.attributes_json, {}),
    startedAt: row.started_at,
    endedAt,
    durationMs: endedAt ? Math.max(0, new Date(endedAt).getTime() - new Date(row.started_at).getTime()) : null,
  };
}

function traceSpanFromRow(row) {
  if (!row) return null;
  const endedAt = row.ended_at ?? null;
  return {
    id: row.id,
    spanId: row.id,
    traceId: row.trace_id,
    parentSpanId: row.parent_span_id,
    executionId: row.execution_id,
    planId: row.plan_id,
    nodeId: row.node_id,
    stepId: row.step_id,
    agentId: row.agent_id,
    name: row.name,
    kind: row.category,
    category: row.category,
    spanKind: row.span_kind,
    status: row.status,
    attributes: parseJson(row.attributes_json, {}),
    input: parseJson(row.input_json, null),
    output: parseJson(row.output_json, null),
    startedAt: row.started_at,
    endedAt,
    durationMs: endedAt ? Math.max(0, new Date(endedAt).getTime() - new Date(row.started_at).getTime()) : null,
  };
}

function traceEventFromRow(row) {
  if (!row) return null;
  const attributes = parseJson(row.attributes_json, {});
  return {
    ...attributes,
    sequence: Number(row.sequence),
    id: row.id,
    traceId: row.trace_id,
    spanId: row.span_id,
    executionId: row.execution_id,
    type: row.type,
    attributes,
    createdAt: row.created_at,
    timestamp: row.created_at,
  };
}

function eventFromRow(row) {
  if (!row) return null;
  const payload = parseJson(row.payload_json, {});
  return {
    ...payload,
    sequence: Number(row.sequence),
    id: row.id,
    executionId: row.execution_id,
    type: row.type,
    payload,
    createdAt: row.created_at,
    timestamp: row.created_at,
  };
}

function artifactFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    executionId: row.execution_id,
    nodeId: row.node_id,
    name: row.name,
    mediaType: row.media_type,
    content: row.content,
    createdAt: row.created_at,
  };
}

function sourceFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    graphId: row.graph_id,
    nodeId: row.node_id,
    filename: row.filename,
    mediaType: row.media_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    objectKey: row.object_key,
    parserId: row.parser_id,
    parserVersion: row.parser_version,
    parseStatus: row.parse_status,
    chunkCount: Number(row.chunk_count ?? 0),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  };
}

function sourceChunkFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceId: row.source_id,
    ordinal: Number(row.ordinal),
    text: row.text,
    location: parseJson(row.location_json, {}),
    contentSha256: row.content_sha256,
    tokenCount: Number(row.token_count),
  };
}

function promptRevisionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentId: row.agent_id,
    version: Number(row.version_number),
    prompt: row.prompt_text,
    outputSchema: parseJson(row.output_schema_json, {}),
    digest: row.digest,
    parentDigest: row.parent_digest,
    createdAt: row.created_at,
  };
}

function agentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    domain: row.domain,
    description: row.description,
    capabilities: parseJson(row.capabilities_json, []),
    toolPolicy: parseJson(row.tool_policy_json, {}),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function providerProfileFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    model: row.model,
    baseUrl: row.base_url,
    enabled: Boolean(row.enabled),
    secretEnvName: row.secret_env_name,
    options: parseJson(row.options_json, {}),
    updatedAt: row.updated_at,
  };
}

export class LocalRepository {
  constructor(databasePath) {
    this.database = new PostgresDatabaseSync(databasePath);
    this.storageInfo = this.database.info;
    try { this.transaction(() => this.migrate()); } catch (error) { this.database.close(); throw error; }
  }

  migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS graphs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        workspace_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS graph_drafts (
        graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        nodes_json TEXT NOT NULL,
        edges_json TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY (graph_id, revision)
      );

      CREATE TABLE IF NOT EXISTS plan_versions (
        id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL CHECK (version_number > 0),
        base_draft_revision INTEGER NOT NULL CHECK (base_draft_revision > 0),
        parent_plan_id TEXT REFERENCES plan_versions(id),
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('AWAITING_APPROVAL', 'APPROVED', 'SUPERSEDED')),
        content_hash TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        plan_json TEXT NOT NULL,
        diff_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        trace_id TEXT,
        UNIQUE (graph_id, version_number),
        UNIQUE (content_hash, graph_id, version_number)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL UNIQUE REFERENCES plan_versions(id) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK (decision = 'APPROVED'),
        approved_content_hash TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL REFERENCES plan_versions(id),
        status TEXT NOT NULL CHECK (status IN ('RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'SUPERSEDED', 'COMPLETED', 'FAILED')),
        parent_execution_id TEXT REFERENCES executions(id),
        root_execution_id TEXT NOT NULL,
        resumed_from_checkpoint_json TEXT,
        pending_plan_id TEXT REFERENCES plan_versions(id),
        completed_node_ids_json TEXT NOT NULL DEFAULT '[]',
        current_node_id TEXT,
        pause_requested INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT
        ,trace_id TEXT
        ,workspace_path TEXT
        ,workspace_binding_digest TEXT
        ,workspace_baseline_json TEXT
      );

      CREATE TABLE IF NOT EXISTS execution_events (
        sequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS execution_events_replay_idx
        ON execution_events (execution_id, sequence);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS artifacts_execution_idx
        ON artifacts (execution_id, created_at);

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
        node_id TEXT,
        filename TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        object_key TEXT NOT NULL,
        parser_id TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        parse_status TEXT NOT NULL CHECK (parse_status IN ('PARSED', 'OPAQUE', 'FAILED')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS sources_graph_node_idx
        ON sources (graph_id, node_id, created_at);

      CREATE INDEX IF NOT EXISTS sources_digest_idx
        ON sources (sha256);

      CREATE TABLE IF NOT EXISTS source_chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        text TEXT NOT NULL,
        location_json TEXT NOT NULL DEFAULT '{}',
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        token_count INTEGER NOT NULL CHECK (token_count >= 0),
        UNIQUE (source_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS source_chunks_source_idx
        ON source_chunks (source_id, ordinal);

      CREATE TABLE IF NOT EXISTS catalog_revisions (
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        parent_digest TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (kind, item_id, version_number)
      );

      CREATE TABLE IF NOT EXISTS agent_definitions (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        domain TEXT NOT NULL,
        description TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        tool_policy_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_prompt_revisions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agent_definitions(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL CHECK (version_number > 0),
        prompt_text TEXT NOT NULL,
        output_schema_json TEXT NOT NULL DEFAULT '{}',
        digest TEXT NOT NULL CHECK (length(digest) = 64),
        parent_digest TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (agent_id, version_number),
        UNIQUE (agent_id, digest)
      );

      CREATE INDEX IF NOT EXISTS agent_prompt_latest_idx
        ON agent_prompt_revisions (agent_id, version_number DESC);

      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        model TEXT,
        base_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        secret_env_name TEXT,
        options_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY CHECK (length(id) = 32),
        schema_version INTEGER NOT NULL,
        graph_id TEXT NOT NULL REFERENCES graphs(id) ON DELETE CASCADE,
        execution_id TEXT REFERENCES executions(id) ON DELETE CASCADE,
        plan_id TEXT REFERENCES plan_versions(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('PLAN', 'EXECUTION')),
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('RUNNING', 'OK', 'ERROR', 'CANCELLED')),
        root_span_id TEXT,
        provider TEXT,
        model TEXT,
        attributes_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        ended_at TEXT,
        UNIQUE (execution_id)
      );

      CREATE INDEX IF NOT EXISTS traces_graph_started_idx
        ON traces (graph_id, started_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS trace_spans (
        id TEXT PRIMARY KEY CHECK (length(id) = 16),
        trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
        parent_span_id TEXT REFERENCES trace_spans(id),
        execution_id TEXT REFERENCES executions(id) ON DELETE CASCADE,
        plan_id TEXT REFERENCES plan_versions(id) ON DELETE SET NULL,
        node_id TEXT,
        step_id TEXT,
        agent_id TEXT,
        name TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('GRAPH', 'PLANNER', 'MODEL', 'AGENT', 'NODE', 'TOOL', 'COMMAND', 'VERIFIER', 'ARTIFACT', 'CHECKPOINT')),
        span_kind TEXT NOT NULL CHECK (span_kind IN ('INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER')),
        status TEXT NOT NULL CHECK (status IN ('RUNNING', 'OK', 'ERROR', 'CANCELLED')),
        attributes_json TEXT NOT NULL DEFAULT '{}',
        input_json TEXT,
        output_json TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );

      CREATE INDEX IF NOT EXISTS trace_spans_trace_started_idx
        ON trace_spans (trace_id, started_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS trace_events (
        sequence BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
        span_id TEXT REFERENCES trace_spans(id) ON DELETE CASCADE,
        execution_id TEXT REFERENCES executions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        attributes_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS trace_events_replay_idx
        ON trace_events (trace_id, sequence ASC);
    `);
    this.database.exec(`
      ALTER TABLE executions ADD COLUMN IF NOT EXISTS selected_node_ids_json TEXT;
      ALTER TABLE executions ADD COLUMN IF NOT EXISTS passed_breakpoint_node_ids_json TEXT;
      ALTER TABLE executions ADD COLUMN IF NOT EXISTS cancelled_at TEXT;
      CREATE TABLE IF NOT EXISTS ege_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO ege_schema_migrations(version, applied_at) VALUES(1, CURRENT_TIMESTAMP::text) ON CONFLICT DO NOTHING;
    `);
  }

  close() {
    this.database.close();
  }

  transaction(callback) {
    const nested = this.transactionDepth > 0;
    const savepoint = `catalog_nested_${this.transactionDepth ?? 0}`;
    this.database.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
    this.transactionDepth = (this.transactionDepth ?? 0) + 1;
    try {
      const result = callback();
      this.database.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.database.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK');
      if (nested) this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  createGraph({ name, description = '', workspacePath = null }) {
    const id = randomUUID();
    const now = timestamp();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO graphs (id, name, description, workspace_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, name, description, workspacePath, now, now);
      this.database.prepare(`
        INSERT INTO graph_drafts (graph_id, revision, nodes_json, edges_json, context, created_at)
        VALUES (?, 1, '[]', '[]', '', ?)
      `).run(id, now);
    });
    return this.getGraph(id);
  }

  getGraph(id) {
    return graphFromRow(this.database.prepare(`
      SELECT g.*, COALESCE(MAX(d.revision), 0) AS draft_revision
      FROM graphs g LEFT JOIN graph_drafts d ON d.graph_id = g.id
      WHERE g.id = ? GROUP BY g.id
    `).get(id));
  }

  listGraphs() {
    return this.database.prepare(`
      SELECT g.*, COALESCE(MAX(d.revision), 0) AS draft_revision
      FROM graphs g LEFT JOIN graph_drafts d ON d.graph_id = g.id
      GROUP BY g.id ORDER BY g.updated_at DESC
    `).all().map(graphFromRow);
  }

  updateGraph(id, { name, description, workspacePath }) {
    const current = this.getGraph(id);
    if (!current) return null;
    this.database.prepare(`
      UPDATE graphs SET name = ?, description = ?, workspace_path = ?, updated_at = ? WHERE id = ?
    `).run(
      name ?? current.name,
      description ?? current.description,
      workspacePath === undefined ? current.workspacePath : workspacePath,
      timestamp(),
      id,
    );
    return this.getGraph(id);
  }

  rebindGraphWorkspace(id, { name, description, workspacePath }) {
    const current = this.getGraph(id);
    if (!current) return null;
    const changed = current.workspacePath !== workspacePath;
    if (!changed) return {
      graph: this.updateGraph(id, { name, description, workspacePath }),
      draft: this.getLatestDraft(id),
      stalePlanIds: [],
      workspaceChanged: false,
    };
    return this.transaction(() => {
      const currentDraft = this.getLatestDraft(id);
      const stalePlanIds = this.database.prepare(
        'SELECT id FROM plan_versions WHERE graph_id = ? ORDER BY version_number ASC',
      ).all(id).map((row) => row.id);
      const changedAt = timestamp();
      this.database.prepare(`
        UPDATE graphs SET name = ?, description = ?, workspace_path = ?, updated_at = ? WHERE id = ?
      `).run(name ?? current.name, description ?? current.description, workspacePath, changedAt, id);
      if (currentDraft) {
        this.database.prepare(`
          INSERT INTO graph_drafts (graph_id, revision, nodes_json, edges_json, context, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          id, currentDraft.revision + 1, JSON.stringify(currentDraft.nodes), JSON.stringify(currentDraft.edges),
          currentDraft.context, changedAt,
        );
      }
      this.database.prepare(`
        UPDATE plan_versions SET status = 'SUPERSEDED'
        WHERE graph_id = ? AND status = 'AWAITING_APPROVAL'
      `).run(id);
      return {
        graph: this.getGraph(id),
        draft: this.getLatestDraft(id),
        stalePlanIds,
        workspaceChanged: true,
      };
    });
  }

  deleteGraph(id) {
    return Number(this.database.prepare('DELETE FROM graphs WHERE id = ?').run(id).changes) > 0;
  }

  saveDraft(graphId, { nodes, edges, context = '' }) {
    const latest = this.getLatestDraft(graphId);
    const revision = (latest?.revision ?? 0) + 1;
    const now = timestamp();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO graph_drafts (graph_id, revision, nodes_json, edges_json, context, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(graphId, revision, JSON.stringify(nodes), JSON.stringify(edges), context, now);
      this.database.prepare('UPDATE graphs SET updated_at = ? WHERE id = ?').run(now, graphId);
    });
    return this.getDraft(graphId, revision);
  }

  getDraft(graphId, revision) {
    return draftFromRow(this.database.prepare(`
      SELECT * FROM graph_drafts WHERE graph_id = ? AND revision = ?
    `).get(graphId, revision));
  }

  getLatestDraft(graphId) {
    return draftFromRow(this.database.prepare(`
      SELECT * FROM graph_drafts WHERE graph_id = ? ORDER BY revision DESC LIMIT 1
    `).get(graphId));
  }

  createSource({
    id = randomUUID(), graphId, nodeId = null, filename, mediaType, byteSize, sha256,
    objectKey, parserId, parserVersion, parseStatus, metadata = {}, chunks = [],
  }) {
    const createdAt = timestamp();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO sources (
          id, graph_id, node_id, filename, media_type, byte_size, sha256, object_key,
          parser_id, parser_version, parse_status, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, graphId, nodeId, filename, mediaType, byteSize, sha256, objectKey,
        parserId, parserVersion, parseStatus, JSON.stringify(metadata), createdAt,
      );
      const insertChunk = this.database.prepare(`
        INSERT INTO source_chunks (
          id, source_id, ordinal, text, location_json, content_sha256, token_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const chunk of chunks) {
        insertChunk.run(
          chunk.id || randomUUID(), id, chunk.ordinal, chunk.text,
          JSON.stringify(chunk.location ?? {}), chunk.contentSha256, chunk.tokenCount,
        );
      }
      return this.getSource(id);
    });
  }

  getSource(id) {
    return sourceFromRow(this.database.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM source_chunks c WHERE c.source_id = s.id) AS chunk_count
      FROM sources s WHERE s.id = ?
    `).get(id));
  }

  listSources(graphId, nodeId) {
    const rows = nodeId === undefined
      ? this.database.prepare(`
          SELECT s.*, (SELECT COUNT(*) FROM source_chunks c WHERE c.source_id = s.id) AS chunk_count
          FROM sources s WHERE s.graph_id = ? ORDER BY s.created_at DESC
        `).all(graphId)
      : nodeId === null
        ? this.database.prepare(`
            SELECT s.*, (SELECT COUNT(*) FROM source_chunks c WHERE c.source_id = s.id) AS chunk_count
            FROM sources s WHERE s.graph_id = ? AND s.node_id IS NULL ORDER BY s.created_at DESC
          `).all(graphId)
        : this.database.prepare(`
            SELECT s.*, (SELECT COUNT(*) FROM source_chunks c WHERE c.source_id = s.id) AS chunk_count
            FROM sources s WHERE s.graph_id = ? AND s.node_id = ? ORDER BY s.created_at DESC
          `).all(graphId, nodeId);
    return rows.map(sourceFromRow);
  }

  listSourceChunks(sourceId) {
    return this.database.prepare(`
      SELECT * FROM source_chunks WHERE source_id = ? ORDER BY ordinal ASC
    `).all(sourceId).map(sourceChunkFromRow);
  }

  listGraphSourceChunks(graphId) {
    return this.database.prepare(`
      SELECT c.*, s.graph_id, s.node_id, s.filename, s.media_type, s.sha256 AS source_sha256
      FROM source_chunks c
      JOIN sources s ON s.id = c.source_id
      WHERE s.graph_id = ? AND s.parse_status = 'PARSED'
      ORDER BY s.created_at ASC, c.ordinal ASC
    `).all(graphId).map((row) => ({
      ...sourceChunkFromRow(row),
      graphId: row.graph_id,
      nodeId: row.node_id,
      filename: row.filename,
      mediaType: row.media_type,
      sourceSha256: row.source_sha256,
    }));
  }

  deleteSource(id) {
    return Number(this.database.prepare('DELETE FROM sources WHERE id = ?').run(id).changes) > 0;
  }

  getCatalogRevision(kind, id) {
    const row = this.database.prepare('SELECT * FROM catalog_revisions WHERE kind = ? AND item_id = ? ORDER BY version_number DESC LIMIT 1').get(kind, id);
    return row ? { id: row.item_id, kind: row.kind, version: row.version_number, data: parseJson(row.data_json, {}), digest: row.digest, parentDigest: row.parent_digest, createdAt: row.created_at } : null;
  }

  listCatalogRevisions(kind) {
    return this.database.prepare('SELECT DISTINCT item_id FROM catalog_revisions WHERE kind = ? ORDER BY item_id').all(kind).map((row) => this.getCatalogRevision(kind, row.item_id));
  }

  catalogHistory(kind, id) {
    return this.database.prepare('SELECT * FROM catalog_revisions WHERE kind = ? AND item_id = ? ORDER BY version_number DESC').all(kind, id).map((row) => ({ id, version: row.version_number, data: parseJson(row.data_json, {}), digest: row.digest, parentDigest: row.parent_digest, createdAt: row.created_at }));
  }

  saveCatalogRevision(kind, id, data, expectedDigest = null) {
    return this.transaction(() => {
      const current = this.getCatalogRevision(kind, id);
      if ((current?.digest ?? null) !== expectedDigest) {
        const error = new Error('This configuration changed. Reload its latest revision before saving.');
        error.code = 'CATALOG_CHANGED';
        throw error;
      }
      const version = (current?.version ?? 0) + 1;
      const digest = createContentDigest({ kind, id, version, parentDigest: current?.digest ?? null, data });
      this.database.prepare('INSERT INTO catalog_revisions (kind, item_id, version_number, data_json, digest, parent_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(kind, id, version, JSON.stringify(data), digest, current?.digest ?? null, timestamp());
      return this.getCatalogRevision(kind, id);
    });
  }

  agentWithConfiguration(row) {
    const agent = agentFromRow(row);
    if (!agent) return null;
    const revision = this.getCatalogRevision('agents', agent.id);
    const config = revision?.data ?? {};
    return { ...agent, ...config, id: agent.id, status: config.archived ? 'DISABLED' : config.status ?? agent.status,
      configVersion: revision?.version ?? 0, configDigest: revision?.digest ?? null,
      currentPrompt: this.getLatestAgentPrompt(agent.id) };
  }

  syncAgentCatalog(catalog) {
    const now = timestamp();
    return this.transaction(() => {
      const insertAgent = this.database.prepare(`
        INSERT INTO agent_definitions (
          id, slug, name, domain, description, capabilities_json, tool_policy_json,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?) ON CONFLICT DO NOTHING
      `);
      const updateBuiltinAgent = this.database.prepare(`
        UPDATE agent_definitions SET
          slug = ?, name = ?, domain = ?, description = ?, capabilities_json = ?,
          tool_policy_json = ?, updated_at = ?
        WHERE id = ? AND (
          slug != ? OR name != ? OR domain != ? OR description != ?
          OR capabilities_json != ? OR tool_policy_json != ?
        )
      `);
      const insertPrompt = this.database.prepare(`
        INSERT INTO agent_prompt_revisions (
          id, agent_id, version_number, prompt_text, output_schema_json, digest, parent_digest, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, NULL, ?) ON CONFLICT DO NOTHING
      `);
      const promptHistory = this.database.prepare(`
        SELECT * FROM agent_prompt_revisions
        WHERE agent_id = ? ORDER BY version_number DESC
      `);
      const insertBuiltinPromptUpgrade = this.database.prepare(`
        INSERT INTO agent_prompt_revisions (
          id, agent_id, version_number, prompt_text, output_schema_json, digest, parent_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const agent of catalog) {
        const capabilitiesJson = JSON.stringify(agent.capabilities);
        const toolPolicyJson = JSON.stringify(agent.toolPolicy);
        insertAgent.run(
          agent.id, agent.slug, agent.name, agent.domain, agent.description,
          capabilitiesJson, toolPolicyJson, now, now,
        );
        if (!this.getCatalogRevision('agents', agent.id)) updateBuiltinAgent.run(
          agent.slug, agent.name, agent.domain, agent.description, capabilitiesJson, toolPolicyJson, now,
          agent.id,
          agent.slug, agent.name, agent.domain, agent.description, capabilitiesJson, toolPolicyJson,
        );
        insertPrompt.run(
          `prompt:${agent.id}:1`, agent.id, agent.prompt,
          JSON.stringify(agent.outputSchema ?? {}), agent.promptDigest, now,
        );
        const history = promptHistory.all(agent.id);
        const latest = history[0];
        const untouchedBuiltinSeed = !this.getCatalogRevision('agents', agent.id) && history.every((revision) => (
          (Number(revision.version_number) === 1 && revision.id === `prompt:${agent.id}:1`)
          || revision.id === `prompt:${agent.id}:builtin:${revision.digest}`
        ));
        if (untouchedBuiltinSeed && latest.digest !== agent.promptDigest && !history.some((revision) => revision.digest === agent.promptDigest)) {
          const version = Number(latest.version_number) + 1;
          insertBuiltinPromptUpgrade.run(
            `prompt:${agent.id}:builtin:${agent.promptDigest}`,
            agent.id,
            version,
            agent.prompt,
            JSON.stringify(agent.outputSchema ?? {}),
            agent.promptDigest,
            latest.digest,
            now,
          );
        }
      }
      return this.listAgents();
    });
  }

  listAgents() {
    return this.database.prepare(`
      SELECT * FROM agent_definitions ORDER BY domain ASC, name ASC
    `).all().map((row) => this.agentWithConfiguration(row));
  }

  getAgent(id) {
    return this.agentWithConfiguration(this.database.prepare('SELECT * FROM agent_definitions WHERE id = ?').get(id));
  }

  createAgent({ id = randomUUID(), slug, name, domain, description, capabilities = [], toolPolicy = {}, prompt, outputSchema = {}, promptDigest }) {
    const now = timestamp();
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO agent_definitions (
          id, slug, name, domain, description, capabilities_json, tool_policy_json,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?) ON CONFLICT DO NOTHING
      `).run(id, slug, name, domain, description, JSON.stringify(capabilities), JSON.stringify(toolPolicy), now, now);
      this.database.prepare(`
        INSERT INTO agent_prompt_revisions (
          id, agent_id, version_number, prompt_text, output_schema_json, digest, parent_digest, created_at
        ) VALUES (?, ?, 1, ?, ?, ?, NULL, ?) ON CONFLICT DO NOTHING
      `).run(randomUUID(), id, prompt, JSON.stringify(outputSchema), promptDigest, now);
      return this.getAgent(id);
    });
  }

  getLatestAgentPrompt(agentId) {
    return promptRevisionFromRow(this.database.prepare(`
      SELECT * FROM agent_prompt_revisions WHERE agent_id = ? ORDER BY version_number DESC LIMIT 1
    `).get(agentId));
  }

  listAgentPrompts(agentId) {
    return this.database.prepare(`
      SELECT * FROM agent_prompt_revisions WHERE agent_id = ? ORDER BY version_number DESC
    `).all(agentId).map(promptRevisionFromRow);
  }

  createAgentPromptRevision(agentId, { prompt, outputSchema = {}, digest, expectedCurrentDigest }) {
    return this.transaction(() => {
      const current = this.getLatestAgentPrompt(agentId);
      if (!current) {
        const error = new Error('Agent prompt history was not found.');
        error.code = 'AGENT_NOT_FOUND';
        throw error;
      }
      if (expectedCurrentDigest && current.digest !== expectedCurrentDigest) {
        const error = new Error('The agent prompt changed before this revision was saved.');
        error.code = 'PROMPT_CHANGED';
        throw error;
      }
      if (current.digest === digest) return current;
      const revision = current.version + 1;
      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO agent_prompt_revisions (
          id, agent_id, version_number, prompt_text, output_schema_json, digest, parent_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, agentId, revision, prompt, JSON.stringify(outputSchema), digest, current.digest, timestamp());
      this.database.prepare('UPDATE agent_definitions SET updated_at = ? WHERE id = ?').run(timestamp(), agentId);
      return this.getLatestAgentPrompt(agentId);
    });
  }

  upsertProviderProfile({ id, label, kind, model = null, baseUrl = null, enabled = false, secretEnvName = null, options = {} }) {
    const updatedAt = timestamp();
    this.database.prepare(`
      INSERT INTO provider_profiles (
        id, label, kind, model, base_url, enabled, secret_env_name, options_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        kind = excluded.kind,
        model = excluded.model,
        base_url = excluded.base_url,
        enabled = excluded.enabled,
        secret_env_name = excluded.secret_env_name,
        options_json = excluded.options_json,
        updated_at = excluded.updated_at
    `).run(id, label, kind, model, baseUrl, enabled ? 1 : 0, secretEnvName, JSON.stringify(options), updatedAt);
    return this.getProviderProfile(id);
  }

  syncProviderProfiles(profiles) {
    const insert = this.database.prepare(`
      INSERT INTO provider_profiles (
        id, label, kind, model, base_url, enabled, secret_env_name, options_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `);
    this.transaction(() => {
      for (const profile of profiles) {
        insert.run(
          profile.id, profile.label, profile.kind, profile.model ?? null, profile.baseUrl ?? null,
          profile.enabled ? 1 : 0, profile.secretEnvName ?? null, JSON.stringify(profile.options ?? {}), timestamp(),
        );
      }
    });
    return this.listProviderProfiles();
  }

  getProviderProfile(id) {
    return providerProfileFromRow(this.database.prepare('SELECT * FROM provider_profiles WHERE id = ?').get(id));
  }

  listProviderProfiles() {
    return this.database.prepare('SELECT * FROM provider_profiles ORDER BY label ASC').all().map(providerProfileFromRow);
  }

  createPlan({ graphId, baseDraftRevision, parentPlanId = null, provider, contentHash, instructions = '', plan, diff, traceId = null }) {
    const version = Number(this.database.prepare(`
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM plan_versions WHERE graph_id = ?
    `).get(graphId).next);
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO plan_versions (
        id, graph_id, version_number, base_draft_revision, parent_plan_id, provider,
        status, content_hash, instructions, plan_json, diff_json, created_at, trace_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'AWAITING_APPROVAL', ?, ?, ?, ?, ?, ?)
    `).run(
      id, graphId, version, baseDraftRevision, parentPlanId, provider,
      contentHash, instructions, JSON.stringify(plan), JSON.stringify(diff), timestamp(), traceId,
    );
    return this.getPlan(id);
  }

  getPlan(id) {
    return planFromRow(this.database.prepare('SELECT * FROM plan_versions WHERE id = ?').get(id));
  }

  listPlans(graphId) {
    return this.database.prepare(`
      SELECT * FROM plan_versions WHERE graph_id = ? ORDER BY version_number DESC
    `).all(graphId).map(planFromRow);
  }

  latestPlan(graphId) {
    return planFromRow(this.database.prepare(`
      SELECT * FROM plan_versions WHERE graph_id = ? ORDER BY version_number DESC LIMIT 1
    `).get(graphId));
  }

  supersedeAwaitingPlan(id) {
    this.database.prepare(`
      UPDATE plan_versions SET status = 'SUPERSEDED'
      WHERE id = ? AND status = 'AWAITING_APPROVAL'
    `).run(id);
    return this.getPlan(id);
  }

  approvePlan(id, expectedContentHash, rationale = '') {
    const existing = this.getApprovalForPlan(id);
    if (existing) {
      if (existing.approvedContentHash !== expectedContentHash) {
        const error = new Error('Approval content hash does not match the requested plan hash.');
        error.code = 'PLAN_HASH_MISMATCH';
        throw error;
      }
      return { plan: this.getPlan(id), approval: existing };
    }
    const approval = {
      id: randomUUID(),
      planId: id,
      decision: 'APPROVED',
      approvedContentHash: expectedContentHash,
      rationale,
      createdAt: timestamp(),
    };
    this.transaction(() => {
      const plan = this.getPlan(id);
      if (!plan || plan.contentHash !== expectedContentHash) {
        const error = new Error('Expected plan content hash does not match the immutable plan.');
        error.code = 'PLAN_HASH_MISMATCH';
        throw error;
      }
      const latestDraft = this.getLatestDraft(plan.graphId);
      if (!latestDraft || latestDraft.revision !== plan.baseDraftRevision) {
        const error = new Error('The graph draft changed after this plan was created.');
        error.code = 'PLAN_DRAFT_STALE';
        throw error;
      }
      this.database.prepare(`
        INSERT INTO approvals (id, graph_id, plan_id, decision, approved_content_hash, context, created_at)
        VALUES (?, ?, ?, 'APPROVED', ?, ?, ?)
      `).run(approval.id, plan.graphId, id, expectedContentHash, rationale, approval.createdAt);
      this.database.prepare(`
        UPDATE plan_versions SET status = 'APPROVED', approved_at = ? WHERE id = ?
      `).run(approval.createdAt, id);
    });
    return { plan: this.getPlan(id), approval: this.getApprovalForPlan(id) };
  }

  getApprovalForPlan(planId) {
    return approvalFromRow(this.database.prepare('SELECT * FROM approvals WHERE plan_id = ?').get(planId));
  }

  createExecution({
    graphId, planId, parentExecutionId = null, rootExecutionId = null,
    resumedFromCheckpoint = null, completedNodeIds = [], workspacePath = null,
    workspaceBindingDigest = null, workspaceBaseline = null, selectedNodeIds = null,
  }) {
    const id = randomUUID();
    const now = timestamp();
    this.database.prepare(`
      INSERT INTO executions (
        id, graph_id, plan_id, status, parent_execution_id, root_execution_id,
        resumed_from_checkpoint_json, completed_node_ids_json,
        created_at, updated_at, started_at, workspace_path, workspace_binding_digest, workspace_baseline_json
      ) VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, graphId, planId, parentExecutionId, rootExecutionId || id,
      resumedFromCheckpoint ? JSON.stringify(resumedFromCheckpoint) : null,
      JSON.stringify(completedNodeIds), now, now, now, workspacePath, workspaceBindingDigest,
      workspaceBaseline ? JSON.stringify(workspaceBaseline) : null,
    );
    if (selectedNodeIds) this.updateExecution(id, { selectedNodeIds });
    return this.getExecution(id);
  }

  createApprovedExecution({ graphId, planId, expectedContentHash, startEventPayload, workspaceBaseline, selectedNodeIds = null }) {
    return this.transaction(() => {
      const plan = this.getPlan(planId);
      const approval = this.getApprovalForPlan(planId);
      const latestDraft = this.getLatestDraft(graphId);
      if (!plan || plan.graphId !== graphId || plan.contentHash !== expectedContentHash) {
        const error = new Error('Expected plan content hash does not match the immutable plan.');
        error.code = 'PLAN_HASH_MISMATCH';
        throw error;
      }
      if (!approval || approval.approvedContentHash !== expectedContentHash) {
        const error = new Error('The approved content hash does not match the requested execution plan.');
        error.code = 'PLAN_APPROVAL_MISMATCH';
        throw error;
      }
      if (!latestDraft || latestDraft.revision !== plan.baseDraftRevision) {
        const error = new Error('The graph draft changed after this plan was created.');
        error.code = 'PLAN_DRAFT_STALE';
        throw error;
      }
      const binding = plan.plan?.contextManifest?.workspaceBinding ?? null;
      const execution = this.createExecution({
        graphId,
        planId,
        selectedNodeIds,
        workspacePath: binding?.canonicalPath ?? null,
        workspaceBindingDigest: binding?.digest ?? null,
        workspaceBaseline: workspaceBaseline === undefined
          ? plan.plan?.contextManifest?.workspaceBaseline ?? null
          : workspaceBaseline,
      });
      const event = this.appendEvent(execution.id, 'execution.started', startEventPayload);
      return { execution, events: [event] };
    });
  }

  startNode({ executionId, nodeId, stepId, title }) {
    return this.transaction(() => {
      const execution = this.getExecution(executionId);
      if (!execution) return { execution: null, events: [] };
      if (execution.completedNodeIds.includes(nodeId)) return { execution, events: [] };
      if (execution.currentNodeId === nodeId) return { execution, events: [] };
      if (execution.status !== 'RUNNING' || execution.currentNodeId) {
        const error = new Error('Execution is not ready to start this node.');
        error.code = 'NODE_START_CONFLICT';
        throw error;
      }
      const updated = this.updateExecution(executionId, { currentNodeId: nodeId });
      const event = this.appendEvent(executionId, 'node.started', { nodeId, stepId, title });
      return { execution: updated, events: [event] };
    });
  }

  completeNode({ executionId, step, artifact, artifacts, receiptArtifact, receiptDocument, workspaceBaseline }) {
    return this.transaction(() => {
      const execution = this.getExecution(executionId);
      if (!execution) return { execution: null, artifacts: [], events: [] };
      if (execution.status === 'CANCELLED') return { execution, artifacts: [], events: [] };
      if (execution.completedNodeIds.includes(step.nodeId)) return { execution, artifacts: [], events: [] };
      if (!['RUNNING', 'PAUSE_REQUESTED'].includes(execution.status) || execution.currentNodeId !== step.nodeId) {
        const error = new Error('Execution node completion does not match the durable in-flight checkpoint.');
        error.code = 'NODE_COMPLETION_CONFLICT';
        throw error;
      }
      const outputDocuments = artifacts ?? [artifact];
      if (!Array.isArray(outputDocuments) || !outputDocuments.length) {
        const error = new Error('Execution node completion requires at least one output artifact.');
        error.code = 'NODE_ARTIFACT_REQUIRED';
        throw error;
      }
      const outputs = outputDocuments.map((document) => this.createArtifact({
        executionId,
        nodeId: step.nodeId,
        name: document.name,
        mediaType: document.mediaType,
        content: document.content,
      }));
      const receipt = this.createArtifact({
        executionId,
        nodeId: step.nodeId,
        name: receiptArtifact.name,
        mediaType: receiptArtifact.mediaType,
        content: receiptArtifact.content,
      });
      const completedNodeIds = [...execution.completedNodeIds, step.nodeId];
      const events = [
        ...outputs.map((output) => this.appendEvent(executionId, 'artifact.created', {
          artifactId: output.id, nodeId: step.nodeId, name: output.name, mediaType: output.mediaType,
        })),
        this.appendEvent(executionId, 'artifact.created', {
          artifactId: receipt.id, nodeId: step.nodeId, name: receipt.name, mediaType: receipt.mediaType,
        }),
        this.appendEvent(executionId, 'verification.receipt', {
          nodeId: step.nodeId,
          artifactId: receipt.id,
          verificationMode: receiptDocument.verificationMode,
          result: receiptDocument.result,
        }),
      ];
      const updated = this.updateExecution(executionId, {
        completedNodeIds,
        currentNodeId: null,
        ...(workspaceBaseline === undefined ? {} : { workspaceBaseline }),
      });
      events.push(this.appendEvent(executionId, 'node.completed', {
        nodeId: step.nodeId,
        stepId: step.id,
        artifactId: outputs[0].id,
        artifactIds: outputs.map((output) => output.id),
        checkpoint: completedNodeIds,
      }));
      return { execution: updated, artifacts: [...outputs, receipt], events };
    });
  }

  completeSimulatedNode(input) {
    return this.completeNode(input);
  }

  failNode({ executionId, step, receiptArtifact, receiptDocument, message }) {
    return this.transaction(() => {
      const execution = this.getExecution(executionId);
      if (!execution || ['FAILED', 'COMPLETED', 'SUPERSEDED', 'CANCELLED'].includes(execution.status)) {
        return { execution, artifacts: [], events: [] };
      }
      if (!['RUNNING', 'PAUSE_REQUESTED'].includes(execution.status) || execution.currentNodeId !== step.nodeId) {
        const error = new Error('Execution node failure does not match the durable in-flight checkpoint.');
        error.code = 'NODE_COMPLETION_CONFLICT';
        throw error;
      }
      const receipt = this.createArtifact({
        executionId,
        nodeId: step.nodeId,
        name: receiptArtifact.name,
        mediaType: receiptArtifact.mediaType,
        content: receiptArtifact.content,
      });
      const events = [
        this.appendEvent(executionId, 'artifact.created', {
          artifactId: receipt.id, nodeId: step.nodeId, name: receipt.name, mediaType: receipt.mediaType,
        }),
        this.appendEvent(executionId, 'verification.receipt', {
          nodeId: step.nodeId,
          artifactId: receipt.id,
          verificationMode: receiptDocument.verificationMode,
          result: receiptDocument.result,
        }),
        this.appendEvent(executionId, 'node.failed', {
          nodeId: step.nodeId,
          stepId: step.id,
          artifactId: receipt.id,
          message,
        }),
      ];
      const updated = this.updateExecution(executionId, {
        status: 'FAILED', currentNodeId: null, completedAt: timestamp(), pauseRequested: false,
      });
      events.push(this.appendEvent(executionId, 'execution.failed', { message, nodeId: step.nodeId }));
      return { execution: updated, artifacts: [receipt], events };
    });
  }

  completeExecution(executionId, payload) {
    return this.transaction(() => {
      const execution = this.getExecution(executionId);
      if (!execution || execution.status === 'COMPLETED') return { execution, events: [] };
      if (execution.status !== 'RUNNING' || execution.currentNodeId) {
        const error = new Error('Execution is not ready for terminal completion.');
        error.code = 'EXECUTION_COMPLETION_CONFLICT';
        throw error;
      }
      const updated = this.updateExecution(executionId, { status: 'COMPLETED', currentNodeId: null, completedAt: timestamp() });
      return { execution: updated, events: [this.appendEvent(executionId, 'execution.completed', payload)] };
    });
  }

  requestPause(executionId) {
    return this.transaction(() => {
      const execution = this.getExecution(executionId);
      if (!execution || execution.status === 'PAUSE_REQUESTED') return { execution, events: [] };
      if (execution.status !== 'RUNNING') {
        const error = new Error('Only a running execution can be paused.');
        error.code = 'EXECUTION_NOT_RUNNING';
        throw error;
      }
      const updated = this.updateExecution(executionId, { status: 'PAUSE_REQUESTED', pauseRequested: true });
      return {
        execution: updated,
        events: [this.appendEvent(executionId, 'execution.pause_requested', {
          takesEffect: 'after-current-node-checkpoint',
        })],
      };
    });
  }

  pauseAtCheckpoint(executionId) {
    return this.transaction(() => {
      const execution = this.getExecution(executionId);
      if (!execution || execution.status === 'PAUSED') return { execution, events: [] };
      if (execution.status !== 'PAUSE_REQUESTED' && !execution.pauseRequested) {
        const error = new Error('Execution has no durable pause request.');
        error.code = 'PAUSE_CONFLICT';
        throw error;
      }
      const updated = this.updateExecution(executionId, {
        status: 'PAUSED', pauseRequested: false, currentNodeId: null,
      });
      return {
        execution: updated,
        events: [this.appendEvent(executionId, 'execution.paused', { checkpoint: updated.completedNodeIds })],
      };
    });
  }

  resumePinnedExecution(executionId) {
    return this.transaction(() => {
      const execution = this.getExecution(executionId);
      if (!execution || execution.status !== 'PAUSED') {
        const error = new Error('Only a paused execution can resume its pinned plan.');
        error.code = 'EXECUTION_NOT_PAUSED';
        throw error;
      }
      const events = [];
      if (execution.pendingPlanId) {
        this.database.prepare(`UPDATE plan_versions SET status = 'SUPERSEDED' WHERE id = ?`).run(execution.pendingPlanId);
        events.push(this.appendEvent(executionId, 'plan.discarded', {
          planId: execution.pendingPlanId,
          reason: 'Resume original pinned plan requested.',
        }));
      }
      const updated = this.updateExecution(executionId, {
        status: 'RUNNING', pauseRequested: false, pendingPlanId: null,
      });
      events.push(this.appendEvent(executionId, 'execution.resumed', {
        planId: updated.planId,
        mode: 'PINNED_PLAN',
        checkpoint: updated.completedNodeIds,
      }));
      return { execution: updated, events };
    });
  }

  failExecution(executionId, message) {
    return this.transaction(() => {
      const execution = this.getExecution(executionId);
      if (!execution || ['FAILED', 'COMPLETED', 'SUPERSEDED', 'CANCELLED'].includes(execution.status)) return { execution, events: [] };
      const updated = this.updateExecution(executionId, { status: 'FAILED', currentNodeId: null, completedAt: timestamp() });
      return { execution: updated, events: [this.appendEvent(executionId, 'execution.failed', { message })] };
    });
  }

  cancelExecution(executionId) {
    return this.transaction(() => {
      const execution = this.getExecution(executionId);
      if (!execution || execution.status === 'CANCELLED') return { execution, events: [] };
      if (!['RUNNING', 'PAUSE_REQUESTED', 'PAUSED'].includes(execution.status)) {
        const error = new Error('Only an active execution can be cancelled.');
        error.code = 'EXECUTION_NOT_ACTIVE';
        throw error;
      }
      const cancelledAt = timestamp();
      // Keep the imported execution-status vocabulary compatible. The explicit
      // cancellation marker distinguishes CANCELLED from failed executions.
      const updated = this.updateExecution(executionId, { status: 'FAILED', cancelledAt, currentNodeId: null, pauseRequested: false, completedAt: cancelledAt });
      return { execution: updated, events: [this.appendEvent(executionId, 'execution.cancelled', { interruptedNodeId: execution.currentNodeId, completedNodeIds: execution.completedNodeIds })] };
    });
  }

  supersedeWithSuccessor({
    predecessorId,
    graphId,
    planId,
    rootExecutionId,
    resumedFromCheckpoint,
    completedNodeIds,
    selectedNodeIds = null,
    predecessorEvent,
    successorEvents,
  }) {
    return this.transaction(() => {
      const currentPredecessor = this.getExecution(predecessorId);
      if (!currentPredecessor || currentPredecessor.status !== 'PAUSED' || currentPredecessor.pendingPlanId !== planId) {
        const error = new Error('Paused predecessor or its pending successor plan changed before continuation admission.');
        error.code = 'EXECUTION_CHANGED';
        throw error;
      }
      const plan = this.getPlan(planId);
      const approval = this.getApprovalForPlan(planId);
      const latestDraft = this.getLatestDraft(graphId);
      if (!plan || !approval || approval.approvedContentHash !== plan.contentHash) {
        const error = new Error('Successor plan is not bound to a matching content approval.');
        error.code = 'PLAN_APPROVAL_MISMATCH';
        throw error;
      }
      if (!latestDraft || latestDraft.revision !== plan.baseDraftRevision) {
        const error = new Error('The graph draft changed after this successor plan was created.');
        error.code = 'PLAN_DRAFT_STALE';
        throw error;
      }
      const successor = this.createExecution({
        graphId,
        planId,
        parentExecutionId: predecessorId,
        rootExecutionId,
        resumedFromCheckpoint,
        completedNodeIds,
        selectedNodeIds,
        workspacePath: plan.plan?.contextManifest?.workspaceBinding?.canonicalPath ?? null,
        workspaceBindingDigest: plan.plan?.contextManifest?.workspaceBinding?.digest ?? null,
        workspaceBaseline: plan.plan?.contextManifest?.workspaceBaseline ?? null,
      });
      const predecessor = this.updateExecution(predecessorId, { status: 'SUPERSEDED', completedAt: timestamp() });
      const events = [
        this.appendEvent(predecessorId, predecessorEvent.type, {
          ...predecessorEvent.payload,
          successorExecutionId: successor.id,
        }),
        ...successorEvents.map((event) => this.appendEvent(successor.id, event.type, event.payload)),
      ];
      return { predecessor, successor, events };
    });
  }

  getExecution(id) {
    return executionFromRow(this.database.prepare('SELECT * FROM executions WHERE id = ?').get(id));
  }

  listExecutions(graphId) {
    return this.database.prepare(`
      SELECT * FROM executions WHERE graph_id = ? ORDER BY created_at DESC
    `).all(graphId).map(executionFromRow);
  }

  findExecutionsByPendingPlan(planId) {
    return this.database.prepare(`
      SELECT * FROM executions WHERE pending_plan_id = ? ORDER BY created_at DESC
    `).all(planId).map(executionFromRow);
  }

  commitReplan({ executionId, expectedPendingPlanId, expectedDraftRevision, draft, planInput }) {
    return this.transaction(() => {
      const execution = this.getExecution(executionId);
      const latestDraft = this.getLatestDraft(execution?.graphId);
      if (!execution || execution.status !== 'PAUSED' || execution.pendingPlanId !== expectedPendingPlanId) {
        const error = new Error('Paused execution changed while the replacement plan was being generated.');
        error.code = 'EXECUTION_CHANGED';
        throw error;
      }
      if (!latestDraft || latestDraft.revision !== expectedDraftRevision) {
        const error = new Error('Graph draft changed while the replacement plan was being generated.');
        error.code = 'DRAFT_CHANGED';
        throw error;
      }
      if (draft) {
        const revision = expectedDraftRevision + 1;
        if (planInput.baseDraftRevision !== revision) {
          throw new Error('Replan draft revision does not match the generated plan input.');
        }
        const createdAt = timestamp();
        this.database.prepare(`
          INSERT INTO graph_drafts (graph_id, revision, nodes_json, edges_json, context, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          execution.graphId,
          revision,
          JSON.stringify(draft.nodes),
          JSON.stringify(draft.edges),
          draft.context,
          createdAt,
        );
        this.database.prepare('UPDATE graphs SET updated_at = ? WHERE id = ?').run(createdAt, execution.graphId);
      }
      const plan = this.createPlan(planInput);
      if (expectedPendingPlanId) this.supersedeAwaitingPlan(expectedPendingPlanId);
      return {
        plan,
        execution: this.updateExecution(executionId, { pendingPlanId: plan.id }),
      };
    });
  }

  updateExecution(id, changes) {
    const current = this.getExecution(id);
    if (!current) return null;
    const map = {
      status: 'status',
      pendingPlanId: 'pending_plan_id',
      completedNodeIds: 'completed_node_ids_json',
      currentNodeId: 'current_node_id',
      pauseRequested: 'pause_requested',
      completedAt: 'completed_at',
      traceId: 'trace_id',
      workspaceBaseline: 'workspace_baseline_json',
      selectedNodeIds: 'selected_node_ids_json',
      passedBreakpointNodeIds: 'passed_breakpoint_node_ids_json',
      cancelledAt: 'cancelled_at',
    };
    const entries = Object.entries(changes).filter(([key]) => key in map);
    if (!entries.length) return current;
    const assignments = entries.map(([key]) => `${map[key]} = ?`);
    const values = entries.map(([key, value]) => {
      if (['completedNodeIds', 'workspaceBaseline', 'selectedNodeIds', 'passedBreakpointNodeIds'].includes(key)) return JSON.stringify(value);
      if (key === 'pauseRequested') return value ? 1 : 0;
      return value;
    });
    assignments.push('updated_at = ?');
    values.push(timestamp(), id);
    this.database.prepare(`UPDATE executions SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    return this.getExecution(id);
  }

  appendEvent(executionId, type, payload = {}) {
    const event = { id: randomUUID(), executionId, type, payload, createdAt: timestamp() };
    const result = this.database.prepare(`
      INSERT INTO execution_events (id, execution_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?) RETURNING sequence
    `).get(event.id, executionId, type, JSON.stringify(payload), event.createdAt);
    return {
      ...payload,
      ...event,
      payload,
      sequence: Number(result.sequence),
      timestamp: event.createdAt,
    };
  }

  listEvents(executionId, after = 0, limit = 2_000) {
    return this.database.prepare(`
      SELECT * FROM execution_events
      WHERE execution_id = ? AND sequence > ?
      ORDER BY sequence ASC LIMIT ?
    `).all(executionId, after, limit).map(eventFromRow);
  }

  createTrace({
    id = createTraceId(), graphId, executionId = null, planId = null, kind, name,
    provider = null, model = null, attributes = {}, startedAt = timestamp(),
  }) {
    return this.transaction(() => {
      const safeAttributes = {
        ...sanitizeTracePayload(attributes),
        captureMode: 'REDACTED_LOCAL',
        exportMode: 'DISABLED',
      };
      this.database.prepare(`
        INSERT INTO traces (
          id, schema_version, graph_id, execution_id, plan_id, kind, name, status,
          provider, model, attributes_json, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?)
      `).run(
        id, TRACE_SCHEMA_VERSION, graphId, executionId, planId, kind, name,
        provider, model, JSON.stringify(safeAttributes), startedAt,
      );
      const events = this._appendTraceEvent(id, null, 'trace.started', {
        traceId: id, kind, name, provider, model, status: 'RUNNING',
      }, executionId);
      return { trace: this.getTrace(id), ...events };
    });
  }

  linkTrace({ traceId, planId, executionId }) {
    const assignments = [];
    const values = [];
    if (planId !== undefined) { assignments.push('plan_id = ?'); values.push(planId); }
    if (executionId !== undefined) { assignments.push('execution_id = ?'); values.push(executionId); }
    if (assignments.length) this.database.prepare(`UPDATE traces SET ${assignments.join(', ')} WHERE id = ?`).run(...values, traceId);
    if (planId) this.database.prepare('UPDATE plan_versions SET trace_id = ? WHERE id = ?').run(traceId, planId);
    if (executionId) this.database.prepare('UPDATE executions SET trace_id = ? WHERE id = ?').run(traceId, executionId);
    return this.getTrace(traceId);
  }

  startTraceSpan({
    id = createSpanId(), traceId, parentSpanId = null, executionId = null, planId = null,
    nodeId = null, stepId = null, agentId = null, name, category = 'GRAPH',
    spanKind = 'INTERNAL', attributes = {}, input = null, root = false, startedAt = timestamp(),
  }) {
    return this.transaction(() => {
      const trace = this.getTrace(traceId);
      if (!trace) throw new Error('Trace was not found.');
      if (trace.endedAt) throw new Error('A terminal trace cannot accept new spans.');
      if (parentSpanId) {
        const parent = this.getTraceSpan(parentSpanId);
        if (!parent || parent.traceId !== traceId) throw new Error('Trace span parent must belong to the same trace.');
      }
      if (root && trace.rootSpanId) throw new Error('Trace already has a root span.');
      const capturedInput = captureTracePayload(input);
      const safeAttributes = sanitizeTracePayload({
        ...attributes,
        ...(capturedInput.metadata ? { inputCapture: capturedInput.metadata } : {}),
      });
      this.database.prepare(`
        INSERT INTO trace_spans (
          id, trace_id, parent_span_id, execution_id, plan_id, node_id, step_id, agent_id,
          name, category, span_kind, status, attributes_json, input_json, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)
      `).run(
        id, traceId, parentSpanId, executionId ?? trace.executionId, planId ?? trace.planId,
        nodeId, stepId, agentId, name, category, spanKind, JSON.stringify(safeAttributes),
        capturedInput.payload == null ? null : JSON.stringify(capturedInput.payload), startedAt,
      );
      if (root) this.database.prepare('UPDATE traces SET root_span_id = ? WHERE id = ?').run(id, traceId);
      const events = this._appendTraceEvent(traceId, id, 'span.started', {
        traceId, spanId: id, parentSpanId, name, kind: category, category, spanKind,
        status: 'RUNNING', nodeId, stepId, agentId,
      }, executionId ?? trace.executionId);
      return { span: this.getTraceSpan(id), ...events };
    });
  }

  appendTraceSpanEvent(spanId, name, attributes = {}) {
    return this.transaction(() => {
      const span = this.getTraceSpan(spanId);
      if (!span) throw new Error('Trace span was not found.');
      if (span.endedAt || this.getTrace(span.traceId)?.endedAt) throw new Error('A terminal trace span cannot accept new events.');
      return this._appendTraceEvent(span.traceId, spanId, 'span.event', {
        traceId: span.traceId, spanId, name, attributes: sanitizeTracePayload(attributes),
      }, span.executionId);
    });
  }

  endTraceSpan(spanId, { status = 'OK', attributes = {}, output = null, endedAt = timestamp() } = {}) {
    return this.transaction(() => {
      const current = this.getTraceSpan(spanId);
      if (!current) throw new Error('Trace span was not found.');
      if (current.endedAt) return { span: current, traceEvent: null, executionEvent: null };
      const capturedOutput = captureTracePayload(output);
      const mergedAttributes = sanitizeTracePayload({
        ...current.attributes,
        ...attributes,
        ...(capturedOutput.metadata ? { outputCapture: capturedOutput.metadata } : {}),
      });
      this.database.prepare(`
        UPDATE trace_spans
        SET status = ?, attributes_json = ?, output_json = ?, ended_at = ?
        WHERE id = ?
      `).run(
        status, JSON.stringify(mergedAttributes),
        capturedOutput.payload == null ? null : JSON.stringify(capturedOutput.payload), endedAt, spanId,
      );
      const span = this.getTraceSpan(spanId);
      const events = this._appendTraceEvent(span.traceId, spanId, 'span.ended', {
        traceId: span.traceId, spanId, name: span.name, kind: span.category, category: span.category,
        spanKind: span.spanKind, status, nodeId: span.nodeId, stepId: span.stepId,
        agentId: span.agentId, durationMs: span.durationMs,
      }, span.executionId);
      return { span, ...events };
    });
  }

  endTrace(traceId, { status = 'OK', attributes = {}, endedAt = timestamp() } = {}) {
    return this.transaction(() => {
      const current = this.getTrace(traceId);
      if (!current) throw new Error('Trace was not found.');
      if (current.endedAt) return { trace: current, traceEvent: null, executionEvent: null };
      const openSpans = this.database.prepare(`
        SELECT * FROM trace_spans WHERE trace_id = ? AND ended_at IS NULL ORDER BY started_at DESC
      `).all(traceId);
      for (const row of openSpans) {
        const forgottenStatus = status === 'CANCELLED' ? 'CANCELLED' : 'ERROR';
        this.database.prepare(`
          UPDATE trace_spans SET status = ?, ended_at = ? WHERE id = ?
        `).run(forgottenStatus, endedAt, row.id);
        this._appendTraceEvent(traceId, row.id, 'span.ended', {
          traceId,
          spanId: row.id,
          name: row.name,
          kind: row.category,
          category: row.category,
          spanKind: row.span_kind,
          status: forgottenStatus,
          nodeId: row.node_id,
          stepId: row.step_id,
          agentId: row.agent_id,
          durationMs: Math.max(0, new Date(endedAt).getTime() - new Date(row.started_at).getTime()),
          telemetryIncomplete: true,
        }, row.execution_id);
      }
      const terminalStatus = status === 'OK' && openSpans.length ? 'ERROR' : status;
      const mergedAttributes = sanitizeTracePayload({
        ...current.attributes,
        ...attributes,
        ...(openSpans.length ? { telemetryIncomplete: true, autoClosedSpanCount: openSpans.length } : {}),
      });
      this.database.prepare(`
        UPDATE traces SET status = ?, attributes_json = ?, ended_at = ? WHERE id = ?
      `).run(terminalStatus, JSON.stringify(mergedAttributes), endedAt, traceId);
      const trace = this.getTrace(traceId);
      const events = this._appendTraceEvent(traceId, trace.rootSpanId, 'trace.ended', {
        traceId, status: terminalStatus, durationMs: trace.durationMs,
      }, trace.executionId);
      return { trace, ...events };
    });
  }

  _appendTraceEvent(traceId, spanId, type, attributes = {}, executionId = null) {
    const event = {
      id: randomUUID(), traceId, spanId, executionId, type,
      attributes: sanitizeTracePayload(attributes) ?? {}, createdAt: timestamp(),
    };
    const result = this.database.prepare(`
      INSERT INTO trace_events (id, trace_id, span_id, execution_id, type, attributes_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING sequence
    `).get(
      event.id, traceId, spanId, executionId, type, JSON.stringify(event.attributes), event.createdAt,
    );
    const traceEvent = {
      ...event.attributes, ...event, sequence: Number(result.sequence), timestamp: event.createdAt,
    };
    const executionEvent = executionId
      ? this.appendEvent(executionId, type, { ...event.attributes, traceId, spanId })
      : null;
    return { traceEvent, executionEvent };
  }

  getTrace(id) {
    return traceFromRow(this.database.prepare('SELECT * FROM traces WHERE id = ?').get(id));
  }

  getTraceByExecution(executionId) {
    return traceFromRow(this.database.prepare('SELECT * FROM traces WHERE execution_id = ?').get(executionId));
  }

  listRunningTraces() {
    return this.database.prepare(`
      SELECT * FROM traces WHERE status = 'RUNNING' ORDER BY started_at ASC, id ASC
    `).all().map(traceFromRow);
  }

  listGraphTraces(graphId, { before = null, limit = 51 } = {}) {
    const rows = before
      ? this.database.prepare(`
          SELECT * FROM traces
          WHERE graph_id = ? AND (started_at < ? OR (started_at = ? AND id < ?))
          ORDER BY started_at DESC, id DESC LIMIT ?
        `).all(graphId, before.startedAt, before.startedAt, before.id, limit)
      : this.database.prepare(`
          SELECT * FROM traces WHERE graph_id = ? ORDER BY started_at DESC, id DESC LIMIT ?
        `).all(graphId, limit);
    return rows.map(traceFromRow);
  }

  getTraceSpan(id) {
    return traceSpanFromRow(this.database.prepare('SELECT * FROM trace_spans WHERE id = ?').get(id));
  }

  findOpenTraceSpan(traceId, { category, nodeId, agentId } = {}) {
    const clauses = ['trace_id = ?', 'ended_at IS NULL'];
    const values = [traceId];
    if (category) { clauses.push('category = ?'); values.push(category); }
    if (nodeId) { clauses.push('node_id = ?'); values.push(nodeId); }
    if (agentId) { clauses.push('agent_id = ?'); values.push(agentId); }
    return traceSpanFromRow(this.database.prepare(`
      SELECT * FROM trace_spans WHERE ${clauses.join(' AND ')} ORDER BY started_at DESC LIMIT 1
    `).get(...values));
  }

  listTraceSpans(traceId) {
    return this.database.prepare(`
      SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC, id ASC
    `).all(traceId).map(traceSpanFromRow);
  }

  listTraceEvents(traceId, after = 0, limit = 2_000) {
    return this.database.prepare(`
      SELECT * FROM trace_events WHERE trace_id = ? AND sequence > ?
      ORDER BY sequence ASC LIMIT ?
    `).all(traceId, after, limit).map(traceEventFromRow);
  }

  listGraphTraceEvents(graphId, after = 0, limit = 2_000) {
    return this.database.prepare(`
      SELECT e.* FROM trace_events e
      JOIN traces t ON t.id = e.trace_id
      WHERE t.graph_id = ? AND e.sequence > ?
      ORDER BY e.sequence ASC LIMIT ?
    `).all(graphId, after, limit).map(traceEventFromRow);
  }

  createArtifact({ executionId, nodeId, name, mediaType = 'text/markdown', content }) {
    const artifact = {
      id: randomUUID(), executionId, nodeId, name, mediaType, content, createdAt: timestamp(),
    };
    this.database.prepare(`
      INSERT INTO artifacts (id, execution_id, node_id, name, media_type, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.id, executionId, nodeId, name, mediaType, content, artifact.createdAt,
    );
    return artifact;
  }

  getArtifact(id) {
    return artifactFromRow(this.database.prepare('SELECT * FROM artifacts WHERE id = ?').get(id));
  }

  listArtifacts(executionId) {
    return this.database.prepare(`
      SELECT * FROM artifacts WHERE execution_id = ? ORDER BY created_at ASC
    `).all(executionId).map(artifactFromRow);
  }

  executionLineageIds(executionId) {
    const ids = [];
    let current = this.getExecution(executionId);
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      ids.unshift(current.id);
      seen.add(current.id);
      current = current.parentExecutionId ? this.getExecution(current.parentExecutionId) : null;
    }
    return ids;
  }

  listLineageArtifacts(executionId) {
    const current = this.getExecution(executionId);
    if (!current) return [];
    const items = this.listArtifacts(current.id).map((artifact) => ({
      ...artifact,
      sourceExecutionId: current.id,
      sourcePlanId: current.planId,
      lineageStatus: 'CURRENT',
    }));
    let child = current;
    let reusable = new Set(child.resumedFromCheckpoint?.reusedNodeIds ?? []);
    while (child.parentExecutionId && reusable.size) {
      const parent = this.getExecution(child.parentExecutionId);
      if (!parent) break;
      items.unshift(...this.listArtifacts(parent.id)
        .filter((artifact) => reusable.has(artifact.nodeId))
        .map((artifact) => ({
          ...artifact,
          sourceExecutionId: parent.id,
          sourcePlanId: parent.planId,
          reusedByExecutionId: executionId,
          lineageStatus: 'REUSED_CHECKPOINT',
        })));
      const parentReusable = new Set(parent.resumedFromCheckpoint?.reusedNodeIds ?? []);
      reusable = new Set([...reusable].filter((nodeId) => parentReusable.has(nodeId)));
      child = parent;
    }
    return items;
  }

  listLineageArtifactHistory(executionId) {
    const currentIds = new Set(this.listLineageArtifacts(executionId).map((artifact) => artifact.id));
    return this.executionLineageIds(executionId).flatMap((id) => {
      const execution = this.getExecution(id);
      return this.listArtifacts(id).map((artifact) => ({
        ...artifact,
        sourceExecutionId: id,
        sourcePlanId: execution.planId,
        lineageStatus: currentIds.has(artifact.id)
          ? (id === executionId ? 'CURRENT' : 'REUSED_CHECKPOINT')
          : 'OBSOLETE_HISTORY',
      }));
    });
  }

  listRecoverableExecutions() {
    return this.database.prepare(`
      SELECT * FROM executions WHERE status IN ('RUNNING', 'PAUSE_REQUESTED') ORDER BY created_at ASC
    `).all().map(executionFromRow);
  }
}
