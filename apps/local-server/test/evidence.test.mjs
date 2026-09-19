import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  EvidenceIndex,
  EvidenceService,
  inspectXlsxArchive,
  retrieveEvidence,
} from '../src/evidence.mjs';
import { LocalObjectStore, sha256Hex } from '../src/object_store.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [path, source] of entries) {
    const name = Buffer.from(path, 'utf8');
    const data = Buffer.from(source, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function columnName(columnNumber) {
  let value = columnNumber;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function sheetXml(rows) {
  const body = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((value, columnIndex) => {
      const address = `${columnName(columnIndex + 1)}${rowNumber}`;
      return `<c r="${address}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function xlsxBrdFixture() {
  const sheets = [
    {
      name: 'Business Requirements',
      rows: [
        ['Requirement ID', 'Title', 'Acceptance Criteria', 'Priority'],
        ['BR-101', 'Customer receipt export', 'PDF and CSV exports preserve order totals', 'High'],
        ['BR-102', 'Accessible checkout', 'All actions work with keyboard navigation', 'High'],
      ],
    },
    {
      name: 'Traceability',
      rows: [
        ['Requirement ID', 'API Contract'],
        ['BR-101', 'POST /graphql exportReceipt mutation'],
      ],
    },
  ];
  const contentOverrides = sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const workbookSheets = sheets.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const relationships = sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  return storedZip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${contentOverrides}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`],
    ...sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet.rows)]),
  ]);
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ege-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const objectStore = new LocalObjectStore({ root: join(root, 'objects'), ...options.objectStore });
  const service = new EvidenceService({ objectStore, ...options.evidence });
  return { root, objectStore, service };
}

test('content-addressed object store publishes once and deduplicates concurrent writes', async (t) => {
  const { objectStore } = await fixture(t);
  const content = Buffer.from('immutable engineering evidence\n', 'utf8');
  const writes = await Promise.all(Array.from({ length: 12 }, () => objectStore.put(content, { mediaType: 'text/plain' })));

  assert.equal(new Set(writes.map((item) => item.id)).size, 1);
  assert.equal(writes.filter((item) => !item.deduplicated).length, 1);
  assert.equal(writes[0].digest, sha256Hex(content));
  assert.equal(writes[0].key, `objects/${writes[0].digest.slice(0, 2)}/${writes[0].digest.slice(2, 4)}/${writes[0].digest}`);
  assert.deepEqual(await objectStore.get(writes[0]), content);
  assert.equal(await objectStore.has(writes[0].id), true);
  assert.equal((await objectStore.stat(writes[0])).size, content.length);
  assert.equal(await objectStore.has('0'.repeat(64)), false);
});

test('evidence ingestion parses bounded text, CSV, JSON, and YAML with durable provenance', async (t) => {
  const { objectStore, service } = await fixture(t, {
    evidence: { limits: { maxChunkChars: 96, maxExtractedChars: 20_000 } },
  });

  const markdown = await service.ingest({
    content: '# Checkout\nCustomers can export a receipt after payment.\nKeyboard navigation is required.',
    sourceName: 'requirements.md',
    mediaType: 'text/markdown',
  });
  assert.equal(markdown.parseStatus, 'parsed');
  assert.equal(markdown.format, 'markdown');
  assert.ok(markdown.chunks.every((chunk) => chunk.characterCount <= 96));
  assert.equal(markdown.chunks[0].citations[0].locator.lineStart, 1);
  assert.equal(markdown.chunks[0].citations[0].digest, markdown.source.object.digest);
  assert.ok(await objectStore.has(markdown.manifestObject));

  const csv = await service.ingest({
    content: 'Requirement ID,Title,Acceptance Criteria\nBR-001,Receipt export,"Exports PDF, CSV, and JSON"\n',
    sourceName: 'requirements.csv',
    mediaType: 'text/csv',
  });
  assert.equal(csv.parseStatus, 'parsed');
  assert.equal(csv.metadata.rowCount, 2);
  assert.match(csv.chunks.map((chunk) => chunk.text).join('\n'), /BR-001/);
  assert.ok(csv.chunks.flatMap((chunk) => chunk.citations).some((citation) => citation.locator.kind === 'csv-row'));

  const json = await service.ingest({
    content: JSON.stringify({ product: { locale: 'ja-JP', capabilities: ['export', 'refund'] } }),
    sourceName: 'requirements.json',
    mediaType: 'application/json',
  });
  assert.equal(json.parseStatus, 'parsed');
  assert.match(json.chunks.map((chunk) => chunk.text).join('\n'), /\/product\/locale: ja-JP/);
  assert.ok(json.chunks.flatMap((chunk) => chunk.citations).some((citation) => citation.locator.pointer === '/product/locale'));

  const yaml = await service.ingest({
    content: 'service:\n  name: checkout\n  availability: 99.95%\n',
    sourceName: 'requirements.yaml',
    mediaType: 'application/yaml',
  });
  assert.equal(yaml.parseStatus, 'parsed');
  assert.match(yaml.chunks.map((chunk) => chunk.text).join('\n'), /\/service\/name: checkout/);
  assert.ok(yaml.chunks.flatMap((chunk) => chunk.citations).some((citation) => citation.locator.kind === 'yaml-pointer'));

  const malformed = await service.ingest({
    content: '{"broken":',
    sourceName: 'broken.json',
    mediaType: 'application/json',
  });
  assert.equal(malformed.parseStatus, 'failed');
  assert.equal(malformed.errors[0].code, 'EVIDENCE_JSON_INVALID');
  assert.ok(await objectStore.has(malformed.source.object));

  const repeated = await service.ingest({
    content: '# Checkout\nCustomers can export a receipt after payment.\nKeyboard navigation is required.',
    sourceName: 'requirements.md',
    mediaType: 'text/markdown',
  });
  assert.equal(repeated.id, markdown.id);
  assert.equal(repeated.manifestObject.id, markdown.manifestObject.id);
  assert.deepEqual(repeated.storage, { sourceDeduplicated: true, manifestDeduplicated: true });
});

test('unsupported evidence is retained with an explicit opaque status and source digest', async (t) => {
  const { objectStore, service } = await fixture(t);
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const document = await service.ingest({ bytes, sourceName: 'proposal.pdf', mediaType: 'application/pdf' });

  assert.equal(document.format, 'opaque');
  assert.equal(document.parseStatus, 'opaque');
  assert.equal(document.metadata.opaqueReason, 'UNSUPPORTED_FORMAT');
  assert.deepEqual(document.chunks, []);
  assert.deepEqual(await objectStore.get(document.source.object), bytes);
});

test('XLSX BRDs retain sheet, row, and cell provenance under archive and workbook limits', async (t) => {
  const { objectStore, service } = await fixture(t);
  const bytes = xlsxBrdFixture();

  const archive = inspectXlsxArchive(bytes);
  assert.ok(archive.entries.length > 0);
  assert.ok(archive.totalUncompressedBytes > 0);

  const document = await service.ingest({
    bytes,
    sourceName: 'checkout-brd.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.equal(document.format, 'xlsx-brd');
  assert.equal(document.parseStatus, 'parsed');
  assert.equal(document.metadata.workbookType, 'business-requirements-document');
  assert.equal(document.metadata.sheetCount, 2);
  assert.match(document.chunks.map((chunk) => chunk.text).join('\n'), /BR-101/);
  const citations = document.chunks.flatMap((chunk) => chunk.citations);
  assert.ok(citations.some((citation) => citation.locator.sheet === 'Business Requirements' && citation.locator.rowStart === 2));
  assert.ok(citations.some((citation) => citation.locator.cells.includes('A2') && citation.locator.cells.includes('C2')));

  const strictlyBounded = new EvidenceService({ objectStore, limits: { maxZipEntries: archive.entries.length - 1 } });
  const rejected = await strictlyBounded.ingest({
    bytes,
    sourceName: 'bounded-brd.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  assert.equal(rejected.parseStatus, 'failed');
  assert.equal(rejected.errors[0].code, 'EVIDENCE_XLSX_ENTRY_LIMIT');
  assert.ok(await objectStore.has(rejected.source.object));
});

test('retrieval deterministically fuses BM25 and trigram rankings with scores and citations', async (t) => {
  const { service } = await fixture(t);
  const documents = await Promise.all([
    service.ingest({
      content: '# Frontend\nKeyboard accessible checkout components and responsive layouts.',
      sourceName: 'frontend.md',
      mediaType: 'text/markdown',
    }),
    service.ingest({
      content: 'Requirement ID,Capability,Acceptance Criteria\nBR-77,Customer receipt export,PDF and CSV export preserves totals\n',
      sourceName: 'export.csv',
      mediaType: 'text/csv',
    }),
    service.ingest({
      content: JSON.stringify({ api: { transport: 'GraphQL', operation: 'refundPayment' } }),
      sourceName: 'api.json',
      mediaType: 'application/json',
    }),
  ]);
  const index = new EvidenceIndex(documents);
  const first = index.search('customer receipt export totals', { topK: 3, rrf: { version: 'rrf-v1', k: 60 } });
  const second = index.search('customer receipt export totals', { topK: 3, rrf: { version: 'rrf-v1', k: 60 } });

  assert.deepEqual(second, first);
  assert.deepEqual(first.fusion.rankers, ['bm25-v1', 'trigram-v1']);
  assert.ok(first.rankLists['bm25-v1'].length > 0);
  assert.ok(first.rankLists['trigram-v1'].length > 0);
  assert.match(first.results[0].text, /Customer receipt export/i);
  assert.ok(first.results[0].score > 0);
  assert.equal(first.results[0].scores.length, 2);
  assert.ok(first.results[0].citations[0].objectId.startsWith('sha256:'));
  assert.ok(first.results[0].citations[0].locator.kind);

  assert.throws(
    () => retrieveEvidence({ query: 'export', documents, rrf: { version: 'rrf-v2' } }),
    (error) => error.code === 'EVIDENCE_RRF_VERSION_UNSUPPORTED',
  );
});

test('ingestion rejects sources beyond its configured pre-storage bound', async (t) => {
  const { objectStore, service } = await fixture(t, {
    evidence: { limits: { maxSourceBytes: 128 } },
  });
  await assert.rejects(
    service.ingest({ content: 'x'.repeat(129), sourceName: 'too-large.txt', mediaType: 'text/plain' }),
    (error) => error.code === 'EVIDENCE_SOURCE_TOO_LARGE',
  );
  assert.equal(await objectStore.has(sha256Hex('x'.repeat(129))), false);
});
