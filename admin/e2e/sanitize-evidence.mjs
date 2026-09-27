import { inflateRawSync, deflateRawSync } from 'node:zlib';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactEvidenceText, redactStructuredEvidence } from './evidence-redaction.mjs';

const ZIP_END = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const TEXT_EXTENSIONS = new Set(['.trace', '.network', '.stacks', '.json', '.jsonl', '.txt', '.md', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.xml', '.svg', '.log', '.yaml', '.yml', '.csv']);
const VISUAL_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.webm', '.mp4']);
const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function findZipEnd(buffer) {
  const floor = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END) return offset;
  }
  throw new Error('Evidence archive is missing a ZIP end record.');
}

function readZipEntries(buffer) {
  const endOffset = findZipEnd(buffer);
  const disk = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntryCount = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntryCount !== entryCount) throw new Error('Multi-disk evidence ZIP is unsupported.');
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 evidence archives are unsupported.');
  if (centralOffset + centralSize > endOffset) throw new Error('Evidence ZIP central directory is out of bounds.');

  const entries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL) throw new Error('Evidence ZIP central directory is malformed.');
    const madeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const time = buffer.readUInt16LE(cursor + 12);
    const date = buffer.readUInt16LE(cursor + 14);
    const expectedCRC = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const internalAttributes = buffer.readUInt16LE(cursor + 36);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 or multi-disk entry is unsupported.');
    if (flags & 1) throw new Error('Encrypted evidence ZIP entries are unsupported.');
    if (method !== 0 && method !== 8) throw new Error(`Evidence ZIP compression method ${method} is unsupported.`);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL) throw new Error(`Evidence ZIP local header is malformed (${name}).`);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const content = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
    if (content.length !== uncompressedSize || crc32(content) !== expectedCRC) throw new Error(`Evidence ZIP entry failed its integrity check (${name}).`);
    entries.push({ name, madeBy, flags, method, time, date, internalAttributes, externalAttributes, content });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('Evidence ZIP central directory length does not match.');
  return entries;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > 0xffff || entry.content.length > 0xffffffff) throw new Error('Evidence ZIP entry exceeds classic ZIP limits.');
    const compressed = entry.method === 8 ? deflateRawSync(entry.content, { level: 6 }) : entry.content;
    if (compressed.length > 0xffffffff) throw new Error('Compressed evidence entry exceeds classic ZIP limits.');
    const checksum = crc32(entry.content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(entry.time, 10);
    local.writeUInt16LE(entry.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL, 0);
    central.writeUInt16LE(entry.madeBy || 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(entry.time, 12);
    central.writeUInt16LE(entry.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(entry.internalAttributes, 36);
    central.writeUInt32LE(entry.externalAttributes, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (entries.length > 0xffff || localOffset > 0xffffffff || centralDirectory.length > 0xffffffff) throw new Error('Evidence ZIP exceeds classic ZIP limits.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function parseText(value, sensitiveValues) {
  const parts = value.split(/(\r?\n)/);
  return parts.map((part) => {
    if (part === '\n' || part === '\r\n') return part;
    try {
      return JSON.stringify(redactStructuredEvidence(JSON.parse(part), sensitiveValues));
    } catch {
      return redactEvidenceText(part, sensitiveValues);
    }
  }).join('');
}

function sanitizeEntry(entry, sensitiveValues) {
  const extension = path.posix.extname(entry.name).toLowerCase();
  if (VISUAL_EXTENSIONS.has(extension)) return entry;
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(entry.content);
  const hasReplacementCharacter = decoded.includes('\ufffd');
  const looksText = TEXT_EXTENSIONS.has(extension)
    || (!hasReplacementCharacter && !decoded.includes('\0') && !/[^\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]/u.test(decoded));
  if (!looksText) return entry;
  const sanitizedText = parseText(decoded, sensitiveValues);
  assertNoKnownValues(sanitizedText, sensitiveValues, entry.name);
  return { ...entry, content: Buffer.from(sanitizedText, 'utf8') };
}

function assertNoKnownValues(text, sensitiveValues, label) {
  for (const value of sensitiveValues) {
    if (!value || value.length < 4) continue;
    let encoded = [value, Buffer.from(value, 'utf8').toString('base64'), Buffer.from(value, 'utf8').toString('base64url')];
    try { encoded.push(encodeURIComponent(value)); } catch { /* Lone surrogates still receive literal redaction. */ }
    if (encoded.some((candidate) => candidate.length >= 4 && text.includes(candidate))) {
      throw new Error(`A registered sensitive value remains in evidence text (${label}).`);
    }
  }
}

export function sanitizeTraceArchive(buffer, sensitiveValues = []) {
  const entries = readZipEntries(buffer).map((entry) => sanitizeEntry(entry, sensitiveValues));
  const sanitized = makeZip(entries);
  // Parse the rewritten archive once here so malformed output never reaches the report.
  const verifiedEntries = readZipEntries(sanitized);
  for (const entry of verifiedEntries) {
    if (!VISUAL_EXTENSIONS.has(path.posix.extname(entry.name).toLowerCase())) {
      const decoded = textBuffer(entry.content, path.posix.extname(entry.name).toLowerCase());
      if (decoded !== undefined) assertNoKnownValues(decoded, sensitiveValues, entry.name);
    }
  }
  return sanitized;
}

function textBuffer(buffer, extension) {
  if (VISUAL_EXTENSIONS.has(extension)) return undefined;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (TEXT_EXTENSIONS.has(extension) || (!decoded.includes('\0') && !/[^\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]/u.test(decoded))) return decoded;
  } catch { return undefined; }
  return undefined;
}

async function sanitizeFile(filePath, sensitiveValues) {
  const content = await readFile(filePath);
  if (content.length >= 4 && (content.readUInt32LE(0) === ZIP_END || content.readUInt32LE(0) === ZIP_LOCAL)) {
    const sanitized = sanitizeTraceArchive(content, sensitiveValues);
    await writeFile(filePath, sanitized);
    return;
  }
  const decoded = textBuffer(content, path.extname(filePath).toLowerCase());
  if (decoded !== undefined) {
    const sanitized = parseText(decoded, sensitiveValues);
    assertNoKnownValues(sanitized, sensitiveValues, path.basename(filePath));
    await writeFile(filePath, sanitized, 'utf8');
  }
}

async function walk(directory, sensitiveValues) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(child, sensitiveValues);
    else if (entry.isFile()) await sanitizeFile(child, sensitiveValues);
    else if ((await lstat(child)).isSymbolicLink()) throw new Error(`Evidence tree contains an unexpected symbolic link: ${child}`);
  }
}

export async function sanitizeEvidenceRoots(roots, sensitiveValues = []) {
  for (const root of roots) await walk(root, sensitiveValues);
}

export async function verifyEvidenceRoots(roots, sensitiveValues = []) {
  const result = { files: 0, archives: 0, textFiles: 0, visualFiles: 0, archiveTextEntries: 0 };
  const visit = async (directory) => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(child); continue; }
      if (!entry.isFile()) continue;
      result.files += 1;
      const content = await readFile(child);
      if (content.length >= 4 && (content.readUInt32LE(0) === ZIP_END || content.readUInt32LE(0) === ZIP_LOCAL)) {
        result.archives += 1;
        for (const archiveEntry of readZipEntries(content)) {
          const extension = path.posix.extname(archiveEntry.name).toLowerCase();
          if (VISUAL_EXTENSIONS.has(extension)) continue;
          const decoded = textBuffer(archiveEntry.content, extension);
          if (decoded !== undefined) {
            result.archiveTextEntries += 1;
            assertNoKnownValues(decoded, sensitiveValues, archiveEntry.name);
          }
        }
        continue;
      }
      const extension = path.extname(child).toLowerCase();
      if (VISUAL_EXTENSIONS.has(extension)) {
        result.visualFiles += 1;
        for (const value of sensitiveValues) if (value.length >= 4 && content.includes(Buffer.from(value, 'utf8'))) throw new Error(`A registered sensitive value remains in media evidence (${path.basename(child)}).`);
        continue;
      }
      const decoded = textBuffer(content, extension);
      if (decoded !== undefined) {
        result.textFiles += 1;
        assertNoKnownValues(decoded, sensitiveValues, path.basename(child));
      }
    }
  };
  for (const root of roots) await visit(root);
  return result;
}

export async function readSensitiveValueFile(filePath) {
  let source;
  try { source = await readFile(filePath, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const values = new Set();
  for (const line of source.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const valuesInLine = JSON.parse(line);
      if (Array.isArray(valuesInLine)) for (const value of valuesInLine) if (typeof value === 'string' && value.length >= 4) values.add(value);
    } catch { throw new Error('Evidence redaction values file is malformed.'); }
  }
  return [...values];
}
