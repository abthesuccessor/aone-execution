import { type ReactNode, useState } from 'react';
import { Badge, Button, Flex, ScrollArea, Text, TextArea, TextField } from '@radix-ui/themes';
import { IconDatabaseSearch, IconFilePlus, IconLoader2, IconSearch, IconTrash } from '@tabler/icons-react';
import type { RetrievalHit, SourceRecord, TopicNode } from '../lib/types';

interface NodeInspectorProps {
  node?: TopicNode;
  configuration?: ReactNode;
  actions?: ReactNode;
  sources: SourceRecord[];
  sourcesLoading: boolean;
  sourcesError?: string;
  uploadingSources?: boolean;
  retrievalHits: RetrievalHit[];
  retrievalLoading?: boolean;
  retrievalError?: string;
  readOnly?: boolean;
  onChange: (patch: Partial<TopicNode>) => void;
  onDelete: () => void;
  onUploadSources: (files: File[]) => Promise<void>;
  onSearchSources: (query: string) => Promise<void>;
}

export function NodeInspector({
  node,
  configuration,
  actions,
  sources,
  sourcesLoading,
  sourcesError,
  uploadingSources,
  retrievalHits,
  retrievalLoading,
  retrievalError,
  readOnly,
  onChange,
  onDelete,
  onUploadSources,
  onSearchSources,
}: NodeInspectorProps) {
  if (!node) {
    return (
      <aside className="node-inspector inspector-empty" aria-label="Node inspector">
        <div className="inspector-empty-mark" aria-hidden="true" />
        <Text size="2" weight="medium">Select a node</Text>
      </aside>
    );
  }

  return (
    <aside className="node-inspector" aria-label={`Inspector for ${node.title}`}>
      <div className="panel-heading inspector-heading">
        <Text size="1" weight="bold">Node configuration</Text>
        <Button variant="ghost" color="red" size="1" onClick={onDelete} disabled={readOnly} aria-label={`Delete ${node.title}`}>
          <IconTrash size={15} />
        </Button>
      </div>
      <ScrollArea key={node.id} type="auto" scrollbars="vertical" className="node-inspector-scroll">
        <div className="node-inspector-content">
          {actions}
          {readOnly && <p className="muted">Editing is locked while the current operation is active.</p>}
          <section className="node-context-fields" aria-label="Editable node context">
            <label className="field-label">
              <Text size="1" weight="medium">Title</Text>
              <TextField.Root
                value={node.title}
                onChange={(event) => onChange({ title: event.target.value })}
                disabled={readOnly}
                aria-label="Node title"
              />
            </label>
            <label className="field-label">
              <Text size="1" weight="medium">Desired outcome</Text>
              <TextArea
                value={node.objective}
                onChange={(event) => onChange({ objective: event.target.value })}
                resize="vertical"
                rows={3}
                disabled={readOnly}
                aria-label="Node desired outcome"
                placeholder="What should be true when this topic is complete?"
              />
            </label>
            <label className="field-label">
              <Flex justify="between" align="baseline">
                <Text size="1" weight="medium">Known context</Text>
                <Text size="1" color="gray">{node.context.length} chars</Text>
              </Flex>
              <TextArea
                value={node.context}
                onChange={(event) => onChange({ context: event.target.value })}
                resize="vertical"
                rows={6}
                disabled={readOnly}
                aria-label="Node known context"
                placeholder="Constraints, concerns, existing code, decisions, examples, and questions"
              />
            </label>
          </section>

          {configuration}
          <div className="node-inspector-supporting">
            <EvidenceSection
              nodeTitle={node.title}
              sources={sources}
              loading={sourcesLoading}
              error={sourcesError}
              uploading={uploadingSources}
              readOnly={readOnly}
              retrievalHits={retrievalHits}
              retrievalLoading={retrievalLoading}
              retrievalError={retrievalError}
              onUpload={onUploadSources}
              onSearch={onSearchSources}
            />
          </div>
        </div>
      </ScrollArea>
    </aside>
  );
}

function EvidenceSection({
  nodeTitle,
  sources,
  loading,
  error,
  uploading,
  readOnly,
  retrievalHits,
  retrievalLoading,
  retrievalError,
  onUpload,
  onSearch,
}: {
  nodeTitle: string;
  sources: SourceRecord[];
  loading: boolean;
  error?: string;
  uploading?: boolean;
  readOnly?: boolean;
  retrievalHits: RetrievalHit[];
  retrievalLoading?: boolean;
  retrievalError?: string;
  onUpload: (files: File[]) => Promise<void>;
  onSearch: (query: string) => Promise<void>;
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searched, setSearched] = useState(false);
  const submitSearch = async () => {
    if (!searchQuery.trim() || retrievalLoading) return;
    setSearched(true);
    await onSearch(searchQuery.trim());
  };

  return (
    <section className="evidence-section" aria-labelledby="evidence-heading">
      <Flex justify="between" align="center" mb="2">
        <Text id="evidence-heading" size="1" weight="medium">Source evidence</Text>
        <Badge color="cyan" variant="soft">{sources.length} attached</Badge>
      </Flex>
      <label className={`source-file-control inspector-source-control${readOnly || uploading ? ' is-disabled' : ''}`}>
        {uploading ? <IconLoader2 className="spin-icon" size={15} aria-hidden="true" /> : <IconFilePlus size={15} aria-hidden="true" />}
        <span>{uploading ? 'Saving draft and uploading' : 'Attach source files'}</span>
        <input
          type="file"
          multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            if (files.length > 0) void onUpload(files);
          }}
          aria-label={`Attach source files to ${nodeTitle}`}
          disabled={readOnly || uploading}
        />
      </label>
      <Text as="p" size="1" color="gray" mt="1" className="evidence-helper">The current draft is persisted before any bytes upload.</Text>

      <div className="source-list" aria-live="polite">
        {loading && <>{[0, 1].map((item) => <div key={item} className="source-skeleton" aria-hidden="true" />)}</>}
        {error && <Text size="1" color="red">{error}</Text>}
        {!loading && !error && sources.length === 0 && (
          <Text size="1" color="gray">No sources attached to this node.</Text>
        )}
        {!loading && sources.map((source) => (
          <article key={source.id} className="source-card">
            <Flex align="start" justify="between" gap="2">
              <Text size="1" weight="medium" title={source.filename} truncate>{source.filename}</Text>
              <Badge size="1" color={sourceStatusColor(source.parseStatus)} variant="soft">{source.parseStatus.toLowerCase()}</Badge>
            </Flex>
            <Text as="p" size="1" color="gray">{source.format ?? fileExtension(source.filename)} · {formatBytes(source.byteSize)} · {source.chunkCount} {source.chunkCount === 1 ? 'chunk' : 'chunks'}</Text>
            <Text as="p" size="1" className="source-provenance" title={source.sha256}>sha256 {source.sha256.slice(0, 12)} · {source.parserId}@{source.parserVersion}</Text>
            {metadataSummary(source.metadata) && <Text as="p" size="1" color="gray">{metadataSummary(source.metadata)}</Text>}
            {source.errors?.map((item, index) => <Text key={`${item.code}:${index}`} as="p" size="1" color="red">{item.code ? `${item.code}: ` : ''}{item.message}</Text>)}
          </article>
        ))}
      </div>

      <details className="evidence-search">
        <summary><IconDatabaseSearch size={14} /> Search graph evidence</summary>
        <form onSubmit={(event) => { event.preventDefault(); void submitSearch(); }}>
          <TextField.Root
            size="1"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Find cited requirements"
            aria-label="Search graph evidence"
          >
            <TextField.Slot><IconSearch size={13} /></TextField.Slot>
          </TextField.Root>
          <Button type="submit" size="1" variant="soft" color="gray" disabled={!searchQuery.trim() || retrievalLoading}>
            {retrievalLoading ? <IconLoader2 className="spin-icon" size={13} /> : <IconSearch size={13} />} Search
          </Button>
        </form>
        {retrievalError && <Text as="p" size="1" color="red">{retrievalError}</Text>}
        {searched && !retrievalLoading && !retrievalError && retrievalHits.length === 0 && (
          <Text as="p" size="1" color="gray">No cited passages matched.</Text>
        )}
        {retrievalHits.length > 0 && (
          <ol className="retrieval-results">
            {retrievalHits.slice(0, 5).map((hit) => (
              <li key={hit.chunkId}>
                <Flex align="center" justify="between" gap="2">
                  <Text size="1" weight="medium">{hit.rank}. {hit.filename}</Text>
                  <Text size="1" color="cyan">{hit.score.toFixed(5)}</Text>
                </Flex>
                <Text as="p" size="1">{hit.text}</Text>
                <Text as="p" size="1" color="gray">{citationSummary(hit)}</Text>
              </li>
            ))}
          </ol>
        )}
      </details>
    </section>
  );
}

function sourceStatusColor(status: SourceRecord['parseStatus']): 'green' | 'amber' | 'red' {
  if (status === 'PARSED') return 'green';
  if (status === 'FAILED') return 'red';
  return 'amber';
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function fileExtension(filename: string): string {
  return filename.includes('.') ? filename.split('.').at(-1)?.toUpperCase() ?? 'source' : 'source';
}

function metadataSummary(metadata: Record<string, unknown>): string {
  const facts = [
    metadata.sheetCount !== undefined ? `${metadata.sheetCount} sheets` : undefined,
    metadata.rowCount !== undefined ? `${metadata.rowCount} rows` : undefined,
    metadata.lineCount !== undefined ? `${metadata.lineCount} lines` : undefined,
    metadata.opaqueReason ? String(metadata.opaqueReason).replaceAll('_', ' ').toLowerCase() : undefined,
  ].filter(Boolean);
  return facts.join(' · ');
}

function citationSummary(hit: RetrievalHit): string {
  const locator = hit.citations[0]?.locator ?? hit.location;
  if (!locator || Object.keys(locator).length === 0) return `chunk ${hit.chunkId.slice(0, 12)}`;
  return Object.entries(locator).map(([key, value]) => `${key}: ${String(value)}`).join(' · ');
}
