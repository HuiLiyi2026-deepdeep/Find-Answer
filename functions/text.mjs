import { AppError } from './errors.mjs';
import { LIMITS } from './config.mjs';

const SUPPORTED_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.pdf']);
const floatView = new Float32Array(1);
const intView = new Uint32Array(floatView.buffer);

export function extensionOf(name) {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

export function sanitizeFileName(raw) {
  const base = String(raw ?? '').replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
}

export function validateUploadName(name) {
  if (!SUPPORTED_EXTENSIONS.has(extensionOf(name))) {
    throw new AppError(
      'unsupported_file',
      '仅支持 TXT、Markdown 和文字型 PDF 文件。',
      400,
    );
  }
}

export function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  } catch {
    throw new AppError('invalid_encoding', '文本文件必须使用 UTF-8 编码。', 400);
  }
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function bisectRight(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (target < values[middle]) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function chunkPages(documentId, fileName, pages, options = {}) {
  const chunkSize = options.chunkSize ?? LIMITS.chunkSize;
  const overlap = options.overlap ?? LIMITS.chunkOverlap;
  if (chunkSize <= 0) throw new Error('chunkSize must be positive');
  if (overlap < 0 || overlap >= chunkSize) throw new Error('overlap out of range');

  const chunks = [];
  const append = (page, text) => {
    const chunkIndex = chunks.length;
    chunks.push({
      id: `${documentId}:${chunkIndex}`,
      document_id: documentId,
      file_name: fileName,
      page,
      chunk_index: chunkIndex,
      text,
    });
  };

  for (const [page, source] of pages) {
    const text = String(source ?? '').trim();
    if (!text) continue;
    // backend/app/chunking.py indexes Python code points, so chunk on a
    // code-point array instead of UTF-16 units (astral characters count once).
    const points = Array.from(text);
    const paragraphEnds = [];
    const paragraphPattern = /\n\s*\n/g;
    let match;
    let scannedUnits = 0;
    let scannedPoints = 0;
    while ((match = paragraphPattern.exec(text)) !== null) {
      // Convert the UTF-16 match offset to a code-point index (one forward scan).
      while (scannedUnits < match.index) {
        const paired = (text.charCodeAt(scannedUnits) & 0xfc00) === 0xd800
          && (text.charCodeAt(scannedUnits + 1) & 0xfc00) === 0xdc00;
        scannedUnits += paired ? 2 : 1;
        scannedPoints += 1;
      }
      paragraphEnds.push(scannedPoints);
    }

    let start = 0;
    let previousEnd = 0;
    while (start < points.length) {
      const maximumEnd = Math.min(start + chunkSize, points.length);
      let end;
      if (maximumEnd === points.length) {
        end = maximumEnd;
      } else {
        const candidateIndex = bisectRight(paragraphEnds, maximumEnd) - 1;
        end = candidateIndex >= 0 && paragraphEnds[candidateIndex] > previousEnd
          ? paragraphEnds[candidateIndex]
          : maximumEnd;
      }

      let contentStart = start;
      let contentEnd = end;
      while (contentStart < contentEnd && /\s/.test(points[contentStart])) contentStart += 1;
      while (contentEnd > contentStart && /\s/.test(points[contentEnd - 1])) contentEnd -= 1;
      if (contentStart < contentEnd) {
        append(page, points.slice(contentStart, contentEnd).join(''));
      }

      if (end === points.length) break;
      previousEnd = end;
      start = Math.max(start + 1, end - overlap);
    }
  }
  return chunks;
}

function floatToHalf(value) {
  floatView[0] = value;
  const bits = intView[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >>> (1 - halfExponent);
    return sign | ((mantissa + 0x1000) >>> 13);
  }
  return sign | (halfExponent << 10) | ((mantissa + 0x1000) >>> 13);
}

function halfToFloat(half) {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >>> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? Number.NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

export function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeVector(vector) {
  const bytes = new Uint8Array(vector.length * 2);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => {
    if (!Number.isFinite(value)) throw new Error('embedding contains a non-finite value');
    view.setUint16(index * 2, floatToHalf(value), true);
  });
  return bytesToBase64(bytes);
}

export function decodeVector(value) {
  const bytes = base64ToBytes(value);
  const view = new DataView(bytes.buffer);
  const vector = new Float32Array(bytes.length / 2);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = halfToFloat(view.getUint16(index * 2, true));
  }
  return vector;
}

export function vectorNorm(vector) {
  let total = 0;
  for (const value of vector) total += value * value;
  return Math.sqrt(total);
}
