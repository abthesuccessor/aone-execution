import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import readExcelFile from 'read-excel-file/node';
import { parseDocument } from 'yaml';

export const EVIDENCE_SCHEMA_VERSION = 'ege.evidence/v1';
export const EVIDENCE_PARSER_REVISION = 'evidence-parser-v1';
export const RRF_VERSION = 'rrf-v1';

export const DEFAULT_EVIDENCE_LIMITS = Object.freeze({
  maxSourceBytes: 8 * 1024 * 1024,
  maxTextBytes: 4 * 1024 * 1024,
  maxExtractedChars: 2 * 1024 * 1024,
  maxChunkChars: 1_800,
  maxChunks: 10_000,
  maxBlocks: 100_000,
  maxRows: 20_000,
  maxColumns: 512,
  maxCells: 100_000,
  maxCellChars: 16_000,
  maxStructuredDepth: 64,
  maxStructuredValues: 50_000,
  maxYamlAliases: 50,
  maxXlsxSheets: 50,
  maxZipEntries: 4_096,
  maxZipUncompressedBytes: 64 * 1024 * 1024,
  maxZipEntryBytes: 16 * 1024 * 1024,
  maxZipCompressionRatio: 200,
});

const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SUPPORTED_FORMATS = new Set(['markdown', 'text', 'csv', 'json', 'yaml', 'xlsx-brd']);

export class EvidenceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'EvidenceError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new EvidenceError(code, message, details);
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  fail('EVIDENCE_INVALID_CONTENT', 'Evidence content must be a string, Buffer, or Uint8Array.');
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function limitsWith(overrides = {}) {
  const limits = { ...DEFAULT_EVIDENCE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail('EVIDENCE_LIMIT_INVALID', `${name} must be a positive safe integer.`);
    }
  }
  if (limits.maxChunkChars < 64) fail('EVIDENCE_LIMIT_INVALID', 'maxChunkChars must be at least 64.');
  return Object.freeze(limits);
}

function normalizedMediaType(mediaType) {
  return String(mediaType || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
}

function safeSourceName(sourceName) {
  const cleaned = String(sourceName || 'evidence').replaceAll('\0', '').trim();
  return (cleaned || 'evidence').slice(0, 1_024);
}

export function detectEvidenceFormat({ sourceName, mediaType } = {}) {
  const extension = extname(String(sourceName || '')).toLowerCase();
  const type = normalizedMediaType(mediaType);
  if (extension === '.xlsx' || type === XLSX_MEDIA_TYPE) return 'xlsx-brd';
  if (extension === '.csv' || ['text/csv', 'application/csv'].includes(type)) return 'csv';
  if (extension === '.json' || type === 'application/json' || type.endsWith('+json')) return 'json';
  if (['.yaml', '.yml'].includes(extension) || ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml'].includes(type)) return 'yaml';
  if (['.md', '.markdown', '.mdown'].includes(extension) || type === 'text/markdown') return 'markdown';
  if (['.txt', '.text', '.log', '.rst'].includes(extension) || type === 'text/plain' || type.startsWith('text/')) return 'text';
  return 'opaque';
}

function decodeUtf8(bytes, limits) {
  if (bytes.length > limits.maxTextBytes) {
    fail('EVIDENCE_TEXT_TOO_LARGE', 'Text evidence exceeds the configured parser limit.', {
      size: bytes.length,
      maxTextBytes: limits.maxTextBytes,
    });
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  } catch {
    fail('EVIDENCE_TEXT_ENCODING_INVALID', 'Text evidence must be valid UTF-8.');
  }
}

function blockCollector(limits) {
  const blocks = [];
  let characters = 0;
  return {
    add(text, locator) {
      const normalized = String(text).trim();
      if (!normalized) return;
      if (blocks.length >= limits.maxBlocks) {
        fail('EVIDENCE_BLOCK_LIMIT', 'Evidence produced too many provenance blocks.', { maxBlocks: limits.maxBlocks });
      }
      characters += normalized.length;
      if (characters > limits.maxExtractedChars) {
        fail('EVIDENCE_EXTRACTED_TEXT_LIMIT', 'Evidence extracted text exceeds the configured limit.', {
          maxExtractedChars: limits.maxExtractedChars,
        });
      }
      blocks.push({ text: normalized, locator });
    },
    result(metadata = {}) {
      return { blocks, metadata: { ...metadata, extractedCharacters: characters, blockCount: blocks.length } };
    },
  };
}

function parseLineDocument(text, format, limits) {
  const collector = blockCollector(limits);
  let section;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (format === 'markdown') {
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (heading) section = heading[1];
    }
    collector.add(line, {
      kind: 'line',
      lineStart: index + 1,
      lineEnd: index + 1,
      ...(section ? { section } : {}),
    });
  }
  return collector.result({ lineCount: lines.length });
}

function parseCsvRows(text, limits) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  const pushField = () => {
    if (field.length > limits.maxCellChars) fail('EVIDENCE_CELL_LIMIT', 'CSV cell exceeds the configured character limit.');
    row.push(field);
    field = '';
    if (row.length > limits.maxColumns) fail('EVIDENCE_COLUMN_LIMIT', 'CSV has too many columns.');
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    if (rows.length > limits.maxRows) fail('EVIDENCE_ROW_LIMIT', 'CSV has too many rows.');
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      if (field.length > limits.maxCellChars) fail('EVIDENCE_CELL_LIMIT', 'CSV cell exceeds the configured character limit.');
      continue;
    }
    if (character === '"') {
      if (field.length) fail('EVIDENCE_CSV_INVALID', 'CSV quote must begin at the start of a field.');
      quoted = true;
    } else if (character === ',') {
      pushField();
    } else if (character === '\n') {
      pushRow();
    } else {
      field += character;
      if (field.length > limits.maxCellChars) fail('EVIDENCE_CELL_LIMIT', 'CSV cell exceeds the configured character limit.');
    }
  }
  if (quoted) fail('EVIDENCE_CSV_INVALID', 'CSV contains an unterminated quoted field.');
  if (field.length || row.length || !text.endsWith('\n')) pushRow();
  while (rows.length && rows.at(-1).every((value) => value === '')) rows.pop();
  return rows;
}

function uniqueHeaders(values) {
  const seen = new Map();
  return values.map((value, index) => {
    const base = String(value || `column_${index + 1}`).trim() || `column_${index + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

function parseCsvDocument(text, limits) {
  const rows = parseCsvRows(text, limits);
  const collector = blockCollector(limits);
  const headers = uniqueHeaders(rows[0] ?? []);
  if (headers.length) collector.add(`Columns: ${headers.join(' | ')}`, { kind: 'csv-row', rowStart: 1, rowEnd: 1 });
  for (let index = 1; index < rows.length; index += 1) {
    const values = rows[index];
    const textRow = headers.map((header, column) => `${header}: ${values[column] ?? ''}`).join(' | ');
    collector.add(textRow, { kind: 'csv-row', rowStart: index + 1, rowEnd: index + 1 });
  }
  return collector.result({
    rowCount: rows.length,
    columnCount: Math.max(0, ...rows.map((row) => row.length)),
    headers,
  });
}

function pointerSegment(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function scalarText(value, limits) {
  let text;
  if (value === null) text = 'null';
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'string') text = value;
  else if (['number', 'boolean', 'bigint'].includes(typeof value)) text = String(value);
  else text = canonicalJson(value);
  if (text.length > limits.maxCellChars) fail('EVIDENCE_VALUE_LIMIT', 'Structured value exceeds the configured character limit.');
  return text;
}

function flattenStructured(value, locatorKind, limits) {
  const collector = blockCollector(limits);
  let values = 0;
  const visit = (current, pointer, depth) => {
    if (depth > limits.maxStructuredDepth) fail('EVIDENCE_DEPTH_LIMIT', 'Structured evidence exceeds the configured nesting depth.');
    values += 1;
    if (values > limits.maxStructuredValues) fail('EVIDENCE_VALUE_COUNT_LIMIT', 'Structured evidence contains too many values.');
    if (Array.isArray(current)) {
      if (!current.length) collector.add(`${pointer || '/'}: []`, { kind: locatorKind, pointer: pointer || '/' });
      current.forEach((item, index) => visit(item, `${pointer}/${index}`, depth + 1));
      return;
    }
    if (current && typeof current === 'object' && !(current instanceof Date)) {
      const keys = Object.keys(current).sort();
      if (!keys.length) collector.add(`${pointer || '/'}: {}`, { kind: locatorKind, pointer: pointer || '/' });
      keys.forEach((key) => visit(current[key], `${pointer}/${pointerSegment(key)}`, depth + 1));
      return;
    }
    collector.add(`${pointer || '/'}: ${scalarText(current, limits)}`, { kind: locatorKind, pointer: pointer || '/' });
  };
  visit(value, '', 0);
  return collector.result({ valueCount: values });
}

function parseJsonDocument(text, limits) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail('EVIDENCE_JSON_INVALID', 'JSON evidence could not be parsed.', { parserMessage: error.message });
  }
  return flattenStructured(value, 'json-pointer', limits);
}

function parseYamlDocument(text, limits) {
  const document = parseDocument(text, {
    customTags: [],
    merge: false,
    prettyErrors: false,
    schema: 'core',
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length) {
    fail('EVIDENCE_YAML_INVALID', 'YAML evidence could not be parsed.', {
      parserMessages: document.errors.slice(0, 5).map((error) => error.message),
    });
  }
  let value;
  try {
    value = document.toJS({ maxAliasCount: limits.maxYamlAliases, mapAsMap: false });
  } catch (error) {
    fail('EVIDENCE_YAML_INVALID', 'YAML aliases or values exceed safe parser limits.', { parserMessage: error.message });
  }
  return flattenStructured(value, 'yaml-pointer', limits);
}

function zipInteger(buffer, offset, bytes) {
  if (offset < 0 || offset + bytes > buffer.length) fail('EVIDENCE_XLSX_INVALID', 'XLSX archive directory is truncated.');
  return bytes === 2 ? buffer.readUInt16LE(offset) : buffer.readUInt32LE(offset);
}

export function inspectXlsxArchive(buffer, limits = DEFAULT_EVIDENCE_LIMITS) {
  limits = limitsWith(limits);
  const bytes = asBuffer(buffer);
  const minimum = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail('EVIDENCE_XLSX_INVALID', 'XLSX does not contain a valid ZIP directory.');
  const disk = zipInteger(bytes, eocd + 4, 2);
  const centralDisk = zipInteger(bytes, eocd + 6, 2);
  const entriesOnDisk = zipInteger(bytes, eocd + 8, 2);
  const entries = zipInteger(bytes, eocd + 10, 2);
  const centralSize = zipInteger(bytes, eocd + 12, 4);
  const centralOffset = zipInteger(bytes, eocd + 16, 4);
  const commentLength = zipInteger(bytes, eocd + 20, 2);
  if (eocd + 22 + commentLength > bytes.length) fail('EVIDENCE_XLSX_INVALID', 'XLSX ZIP comment is truncated.');
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) fail('EVIDENCE_XLSX_MULTIDISK', 'Multi-disk XLSX archives are not supported.');
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail('EVIDENCE_XLSX_ZIP64_UNSUPPORTED', 'ZIP64 XLSX archives are outside the bounded local parser contract.');
  }
  if (entries > limits.maxZipEntries) fail('EVIDENCE_XLSX_ENTRY_LIMIT', 'XLSX contains too many archive entries.');
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > bytes.length) {
    fail('EVIDENCE_XLSX_INVALID', 'XLSX central directory points outside the source object.');
  }

  let offset = centralOffset;
  let totalUncompressedBytes = 0;
  const archiveEntries = [];
  for (let index = 0; index < entries; index += 1) {
    if (zipInteger(bytes, offset, 4) !== 0x02014b50) fail('EVIDENCE_XLSX_INVALID', 'XLSX central directory entry is invalid.');
    const flags = zipInteger(bytes, offset + 8, 2);
    const compression = zipInteger(bytes, offset + 10, 2);
    const compressedSize = zipInteger(bytes, offset + 20, 4);
    const uncompressedSize = zipInteger(bytes, offset + 24, 4);
    const nameLength = zipInteger(bytes, offset + 28, 2);
    const extraLength = zipInteger(bytes, offset + 30, 2);
    const entryCommentLength = zipInteger(bytes, offset + 32, 2);
    const end = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (end > centralOffset + centralSize || end > bytes.length) fail('EVIDENCE_XLSX_INVALID', 'XLSX central directory entry is truncated.');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if ((flags & 0x1) !== 0) fail('EVIDENCE_XLSX_ENCRYPTED', 'Encrypted XLSX archives are not supported.');
    if (![0, 8].includes(compression)) fail('EVIDENCE_XLSX_COMPRESSION_UNSUPPORTED', `XLSX entry ${name} uses an unsupported compression method.`);
    if (name.startsWith('/') || name.startsWith('\\') || name.split(/[\\/]/).includes('..')) {
      fail('EVIDENCE_XLSX_PATH_INVALID', 'XLSX archive contains an unsafe entry path.');
    }
    if (uncompressedSize > limits.maxZipEntryBytes) fail('EVIDENCE_XLSX_ENTRY_SIZE_LIMIT', `XLSX entry ${name} is too large.`);
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > limits.maxZipUncompressedBytes) {
      fail('EVIDENCE_XLSX_UNCOMPRESSED_LIMIT', 'XLSX expanded content exceeds the configured limit.');
    }
    const ratio = uncompressedSize / Math.max(1, compressedSize);
    if (ratio > limits.maxZipCompressionRatio) fail('EVIDENCE_XLSX_RATIO_LIMIT', `XLSX entry ${name} exceeds the compression-ratio limit.`);
    archiveEntries.push({ name, compressedSize, uncompressedSize, compression });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) fail('EVIDENCE_XLSX_INVALID', 'XLSX central directory size does not match its entries.');
  return { entries: archiveEntries, totalUncompressedBytes };
}

function excelScalar(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('');
  if ('formula' in value || 'sharedFormula' in value) {
    const formula = value.formula ?? value.sharedFormula;
    const result = value.result === undefined ? '' : excelScalar(value.result);
    return result ? `Formula ${formula}; result ${result}` : `Formula ${formula}`;
  }
  if ('text' in value) return String(value.text);
  if ('hyperlink' in value) return String(value.text ?? value.hyperlink);
  if ('error' in value) return String(value.error);
  return canonicalJson(value);
}

function excelColumnName(columnNumber) {
  let value = columnNumber;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

async function parseXlsxBrd(bytes, limits) {
  const archive = inspectXlsxArchive(bytes, limits);
  let workbookSheets;
  try {
    workbookSheets = await readExcelFile(bytes);
  } catch (error) {
    fail('EVIDENCE_XLSX_INVALID', 'XLSX workbook could not be parsed.', { parserMessage: error.message });
  }
  if (workbookSheets.length > limits.maxXlsxSheets) fail('EVIDENCE_XLSX_SHEET_LIMIT', 'XLSX contains too many worksheets.');

  const collector = blockCollector(limits);
  let totalRows = 0;
  let totalCells = 0;
  const sheets = [];
  for (const worksheet of workbookSheets) {
    const headers = new Map();
    let firstRow = true;
    let sheetRows = 0;
    let sheetCells = 0;
    for (let rowIndex = 0; rowIndex < worksheet.data.length; rowIndex += 1) {
      const row = worksheet.data[rowIndex];
      const rowNumber = rowIndex + 1;
      if (!Array.isArray(row) || row.every((value) => value === null || value === undefined || value === '')) continue;
      totalRows += 1;
      sheetRows += 1;
      if (totalRows > limits.maxRows || rowNumber > limits.maxRows) fail('EVIDENCE_ROW_LIMIT', 'XLSX contains too many rows.');
      const cells = [];
      for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
        const value = row[columnIndex];
        if (value === null || value === undefined || value === '') continue;
        const columnNumber = columnIndex + 1;
        totalCells += 1;
        sheetCells += 1;
        if (totalCells > limits.maxCells) fail('EVIDENCE_CELL_COUNT_LIMIT', 'XLSX contains too many populated cells.');
        if (columnNumber > limits.maxColumns) fail('EVIDENCE_COLUMN_LIMIT', 'XLSX contains a column outside the configured bound.');
        const address = `${excelColumnName(columnNumber)}${rowNumber}`;
        const text = excelScalar(value).trim();
        if (text.length > limits.maxCellChars) fail('EVIDENCE_CELL_LIMIT', `XLSX cell ${worksheet.sheet}!${address} is too large.`);
        if (text) cells.push({ address, columnNumber, text });
      }
      if (!cells.length) continue;
      const isHeaderRow = firstRow;
      if (isHeaderRow) {
        cells.forEach((cell) => headers.set(cell.columnNumber, cell.text));
        firstRow = false;
      }
      const rowText = cells.map((cell) => {
        const header = headers.get(cell.columnNumber);
        return header && !isHeaderRow ? `${header}: ${cell.text}` : `${cell.address}: ${cell.text}`;
      }).join(' | ');
      collector.add(rowText, {
        kind: 'xlsx-row',
        sheet: worksheet.sheet,
        rowStart: rowNumber,
        rowEnd: rowNumber,
        cells: cells.map((cell) => cell.address),
      });
    }
    sheets.push({ name: worksheet.sheet, rowCount: sheetRows, cellCount: sheetCells });
  }
  return collector.result({
    workbookType: 'business-requirements-document',
    sheetCount: workbookSheets.length,
    rowCount: totalRows,
    cellCount: totalCells,
    archiveEntryCount: archive.entries.length,
    archiveUncompressedBytes: archive.totalUncompressedBytes,
    sheets,
  });
}

function splitBounded(text, maximum) {
  const segments = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + maximum);
    if (end < text.length) {
      const boundary = text.lastIndexOf(' ', end);
      if (boundary > offset + Math.floor(maximum / 2)) end = boundary;
    }
    segments.push({ text: text.slice(offset, end), start: offset, end });
    offset = end;
    while (text[offset] === ' ') offset += 1;
  }
  return segments;
}

function stableObjectReference(reference) {
  return {
    id: reference.id,
    algorithm: reference.algorithm,
    digest: reference.digest,
    size: reference.size,
    key: reference.key,
  };
}

function createChunks({ blocks, documentId, source, format, parserRevision, limits }) {
  const chunks = [];
  let parts = [];
  let citations = [];
  let length = 0;

  const flush = () => {
    if (!parts.length) return;
    const text = parts.join('\n');
    const ordinal = chunks.length;
    const contentDigest = hashText(text);
    const citationSet = new Map(citations.map((citation) => [canonicalJson(citation), citation]));
    const stableCitations = [...citationSet.values()];
    const idDigest = hashText(canonicalJson({ documentId, ordinal, contentDigest, citations: stableCitations, parserRevision }));
    chunks.push({
      id: `chunk:${idDigest}`,
      ordinal,
      documentId,
      contentDigest,
      text,
      characterCount: text.length,
      citations: stableCitations,
    });
    if (chunks.length > limits.maxChunks) fail('EVIDENCE_CHUNK_LIMIT', 'Evidence produced too many chunks.');
    parts = [];
    citations = [];
    length = 0;
  };

  for (const block of blocks) {
    for (const segment of splitBounded(block.text, limits.maxChunkChars)) {
      const separator = parts.length ? 1 : 0;
      if (length + separator + segment.text.length > limits.maxChunkChars) flush();
      parts.push(segment.text);
      length += (parts.length > 1 ? 1 : 0) + segment.text.length;
      citations.push({
        documentId,
        objectId: source.object.id,
        digest: source.object.digest,
        sourceName: source.name,
        mediaType: source.mediaType,
        format,
        parserRevision,
        locator: {
          ...block.locator,
          ...(segment.start || segment.end < block.text.length
            ? { segmentStart: segment.start, segmentEnd: segment.end }
            : {}),
        },
      });
    }
  }
  flush();
  return chunks;
}

async function parseSupported(format, bytes, limits) {
  if (format === 'xlsx-brd') return parseXlsxBrd(bytes, limits);
  const text = decodeUtf8(bytes, limits);
  if (format === 'markdown' || format === 'text') return parseLineDocument(text, format, limits);
  if (format === 'csv') return parseCsvDocument(text, limits);
  if (format === 'json') return parseJsonDocument(text, limits);
  if (format === 'yaml') return parseYamlDocument(text, limits);
  fail('EVIDENCE_FORMAT_UNSUPPORTED', `Unsupported evidence format: ${format}.`);
}

function safeParseError(error) {
  return {
    code: error.code || 'EVIDENCE_PARSE_FAILED',
    message: error instanceof EvidenceError ? error.message : 'Evidence parser failed.',
    ...(error instanceof EvidenceError && error.details !== undefined ? { details: error.details } : {}),
  };
}

export class EvidenceService {
  constructor({ objectStore, limits, parserRevision = EVIDENCE_PARSER_REVISION } = {}) {
    if (!objectStore || typeof objectStore.put !== 'function' || typeof objectStore.get !== 'function') {
      fail('EVIDENCE_OBJECT_STORE_REQUIRED', 'EvidenceService requires an object store with put and get methods.');
    }
    this.objectStore = objectStore;
    this.limits = limitsWith(limits);
    this.parserRevision = String(parserRevision || EVIDENCE_PARSER_REVISION);
  }

  async ingest({ content, bytes, data, sourceName, filename, mediaType = 'application/octet-stream' } = {}) {
    const sourceBytes = Buffer.from(asBuffer(bytes ?? content ?? data));
    if (sourceBytes.length > this.limits.maxSourceBytes) {
      fail('EVIDENCE_SOURCE_TOO_LARGE', 'Evidence source exceeds the configured ingestion limit.', {
        size: sourceBytes.length,
        maxSourceBytes: this.limits.maxSourceBytes,
      });
    }
    const name = safeSourceName(sourceName ?? filename);
    const type = normalizedMediaType(mediaType);
    const format = detectEvidenceFormat({ sourceName: name, mediaType: type });
    const storedSource = await this.objectStore.put(sourceBytes, { mediaType: type });
    const source = { name, mediaType: type, object: stableObjectReference(storedSource) };
    const documentId = `evidence:${hashText(canonicalJson({
      objectId: source.object.id,
      name,
      mediaType: type,
      format,
      parserRevision: this.parserRevision,
    }))}`;

    let parseStatus = 'opaque';
    let metadata = {};
    let chunks = [];
    let errors = [];
    if (SUPPORTED_FORMATS.has(format)) {
      try {
        const parsed = await parseSupported(format, sourceBytes, this.limits);
        metadata = parsed.metadata;
        chunks = createChunks({
          blocks: parsed.blocks,
          documentId,
          source,
          format,
          parserRevision: this.parserRevision,
          limits: this.limits,
        });
        parseStatus = 'parsed';
      } catch (error) {
        parseStatus = 'failed';
        errors = [safeParseError(error)];
      }
    } else {
      metadata = { opaqueReason: 'UNSUPPORTED_FORMAT' };
    }

    const manifest = {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      id: documentId,
      source,
      format,
      parseStatus,
      parser: { id: 'bounded-evidence-parser', revision: this.parserRevision },
      metadata,
      chunks,
      errors,
    };
    const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8');
    const storedManifest = await this.objectStore.put(manifestBytes, { mediaType: 'application/vnd.ege.evidence+json' });
    return {
      ...manifest,
      manifestObject: stableObjectReference(storedManifest),
      storage: {
        sourceDeduplicated: storedSource.deduplicated,
        manifestDeduplicated: storedManifest.deduplicated,
      },
    };
  }
}

function normalizeSearchText(value) {
  return String(value).normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function tokens(value) {
  const normalized = normalizeSearchText(value);
  return normalized ? normalized.split(' ') : [];
}

function termCounts(values) {
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return counts;
}

function bm25Scores(query, chunks) {
  const queryTerms = [...new Set(tokens(query))];
  const documents = chunks.map((chunk) => tokens(chunk.text));
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, documents.length);
  const frequencies = documents.map(termCounts);
  const documentFrequency = new Map();
  queryTerms.forEach((term) => {
    documentFrequency.set(term, frequencies.filter((counts) => counts.has(term)).length);
  });
  const k1 = 1.2;
  const b = 0.75;
  return chunks.map((chunk, index) => {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = frequencies[index].get(term) ?? 0;
      if (!frequency) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + ((chunks.length - df + 0.5) / (df + 0.5)));
      const denominator = frequency + k1 * (1 - b + b * (documents[index].length / Math.max(1, averageLength)));
      score += idf * ((frequency * (k1 + 1)) / denominator);
    }
    return { chunk, score };
  });
}

function ngrams(value, width = 3) {
  const normalized = normalizeSearchText(value);
  if (!normalized) return new Set();
  if (normalized.length <= width) return new Set([normalized]);
  const output = new Set();
  for (let index = 0; index <= normalized.length - width; index += 1) output.add(normalized.slice(index, index + width));
  return output;
}

function trigramScores(query, chunks) {
  const queryText = normalizeSearchText(query);
  const queryGrams = ngrams(queryText);
  return chunks.map((chunk) => {
    const text = normalizeSearchText(chunk.text);
    const chunkGrams = ngrams(text);
    let intersection = 0;
    queryGrams.forEach((gram) => {
      if (chunkGrams.has(gram)) intersection += 1;
    });
    const dice = queryGrams.size && chunkGrams.size ? (2 * intersection) / (queryGrams.size + chunkGrams.size) : 0;
    const containment = queryText && text.includes(queryText) ? 1 : 0;
    return { chunk, score: dice + containment };
  });
}

function rankedList(id, scored) {
  return scored.filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
    .map((item, index) => ({ ranker: id, rank: index + 1, chunk: item.chunk, score: item.score }));
}

function rounded(value) {
  return Number(value.toFixed(12));
}

export function retrieveEvidence({ query, documents = [], chunks, topK = 10, rrf = {} } = {}) {
  const queryText = String(query ?? '').trim();
  if (!queryText) fail('EVIDENCE_QUERY_REQUIRED', 'A non-empty evidence query is required.');
  if (queryText.length > 2_000) fail('EVIDENCE_QUERY_TOO_LARGE', 'Evidence query exceeds 2,000 characters.');
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > 100) fail('EVIDENCE_TOP_K_INVALID', 'topK must be between 1 and 100.');
  const version = rrf.version ?? RRF_VERSION;
  const k = rrf.k ?? 60;
  if (version !== RRF_VERSION) fail('EVIDENCE_RRF_VERSION_UNSUPPORTED', `Unsupported RRF version: ${version}.`);
  if (!Number.isSafeInteger(k) || k < 1 || k > 10_000) fail('EVIDENCE_RRF_K_INVALID', 'RRF k must be between 1 and 10,000.');

  const candidates = chunks ?? documents.flatMap((document) => document.parseStatus === 'parsed' ? document.chunks : []);
  if (!Array.isArray(candidates)) fail('EVIDENCE_CANDIDATES_INVALID', 'Evidence chunks must be an array.');
  if (candidates.length > 50_000) fail('EVIDENCE_CANDIDATE_LIMIT', 'Evidence retrieval exceeds 50,000 candidate chunks.');
  const unique = [...new Map(candidates.map((chunk) => [chunk.id, chunk])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));

  const lists = [
    rankedList('bm25-v1', bm25Scores(queryText, unique)),
    rankedList('trigram-v1', trigramScores(queryText, unique)),
  ];
  const fused = new Map();
  for (const list of lists) {
    for (const item of list) {
      const current = fused.get(item.chunk.id) ?? { chunk: item.chunk, score: 0, contributions: [] };
      const contribution = 1 / (k + item.rank);
      current.score += contribution;
      current.contributions.push({
        ranker: item.ranker,
        rank: item.rank,
        sourceScore: rounded(item.score),
        rrfContribution: rounded(contribution),
      });
      fused.set(item.chunk.id, current);
    }
  }
  const results = [...fused.values()]
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
    .slice(0, topK)
    .map((item, index) => ({
      rank: index + 1,
      chunkId: item.chunk.id,
      documentId: item.chunk.documentId,
      text: item.chunk.text,
      score: rounded(item.score),
      scores: item.contributions.sort((left, right) => left.ranker.localeCompare(right.ranker)),
      citations: item.chunk.citations,
    }));

  return {
    query: queryText,
    fusion: {
      method: 'reciprocal_rank_fusion',
      version,
      k,
      rankers: ['bm25-v1', 'trigram-v1'],
    },
    candidateCount: unique.length,
    rankLists: Object.fromEntries(lists.map((list) => [list[0]?.ranker ?? (lists.indexOf(list) === 0 ? 'bm25-v1' : 'trigram-v1'), list.map((item) => ({
      chunkId: item.chunk.id,
      rank: item.rank,
      score: rounded(item.score),
    }))])),
    results,
  };
}

export class EvidenceIndex {
  constructor(documents = []) {
    this.documents = new Map();
    documents.forEach((document) => this.add(document));
  }

  add(document) {
    if (!document?.id || !Array.isArray(document.chunks)) fail('EVIDENCE_DOCUMENT_INVALID', 'Indexed evidence requires an id and chunks.');
    this.documents.set(document.id, document);
    return this;
  }

  remove(documentId) {
    return this.documents.delete(documentId);
  }

  search(query, options = {}) {
    return retrieveEvidence({ query, documents: [...this.documents.values()], ...options });
  }
}
