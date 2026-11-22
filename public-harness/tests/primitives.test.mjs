import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dayKey, hashIp, isIpLiteral, trustedClientIp,
} from '../../functions/client-ip.mjs';
import { AppError, UniqueConflict } from '../../functions/errors.mjs';
import {
  chunkPages, decodeVector, encodeVector, sanitizeFileName, sha256Hex, vectorNorm,
} from '../../functions/text.mjs';

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// Expected values computed with backend/app/chunking.py:
//   text = '开头\U0001F642说明文字甲\U0001F600乙丙丁\n\n戊己庚\U0001F680辛壬癸子丑寅卯\U0001F30F辰巳午未申酉'
//   chunk_pages('doc-astral', 'astral.txt', [(1, text)], chunk_size=12, overlap=4)
// -> len(text) == 32 code points, 4 chunks of 12/12/12/8 code points.
const ASTRAL_TEXT = '开头🙂说明文字甲😀乙丙丁\n\n戊己庚🚀辛壬癸子丑寅卯🌏辰巳午未申酉';
const ASTRAL_CHUNKS = [
  '开头🙂说明文字甲😀乙丙丁',
  '😀乙丙丁\n\n戊己庚🚀辛壬',
  '庚🚀辛壬癸子丑寅卯🌏辰巳',
  '卯🌏辰巳午未申酉',
];

test('Shanghai day keys cross the UTC boundary', () => {
  assert.equal(dayKey(new Date('2026-10-30T15:59:59Z')), '2026-10-30');
  assert.equal(dayKey(new Date('2026-10-30T16:00:00Z')), '2026-10-31');
});

test('only gateway-overwritten headers with one IP literal are trusted', () => {
  assert.equal(isIpLiteral('203.0.113.9'), true);
  assert.equal(isIpLiteral('2001:db8::1'), true);
  assert.equal(isIpLiteral('not-an-ip'), false);
  assert.equal(isIpLiteral('203.0.113.9:443'), false);

  const trusted = new Request('https://site.test/api/health', {
    headers: { 'x-envoy-external-address': '203.0.113.9' },
  });
  assert.deepEqual(trustedClientIp(trusted), {
    ip: '203.0.113.9', source: 'x-envoy-external-address',
  });

  const fallback = new Request('https://site.test/api/health', {
    headers: { 'x-real-ip': '2001:db8::1' },
  });
  assert.deepEqual(trustedClientIp(fallback), {
    ip: '2001:db8::1', source: 'x-real-ip',
  });

  const spoofedForwarded = new Request('https://site.test/api/health', {
    headers: { 'x-forwarded-for': '198.51.100.4' },
  });
  assert.equal(trustedClientIp(spoofedForwarded), null);

  const spoofedClientIp = new Request('https://site.test/api/health', {
    headers: { 'x-real-client-ip': '198.51.100.4' },
  });
  assert.equal(trustedClientIp(spoofedClientIp), null);

  const malformed = new Request('https://site.test/api/health', {
    headers: { 'x-envoy-external-address': 'unknown' },
  });
  assert.equal(trustedClientIp(malformed), null);

  const list = new Request('https://site.test/api/health', {
    headers: { 'x-envoy-external-address': '203.0.113.9, 198.51.100.4' },
  });
  assert.equal(trustedClientIp(list), null);

  const duplicatedHeaders = new Headers();
  duplicatedHeaders.append('x-envoy-external-address', '203.0.113.9');
  duplicatedHeaders.append('x-envoy-external-address', '203.0.113.9');
  assert.equal(duplicatedHeaders.get('x-envoy-external-address'), '203.0.113.9, 203.0.113.9');
  const duplicated = new Request('https://site.test/api/health', {
    headers: duplicatedHeaders,
  });
  assert.equal(trustedClientIp(duplicated), null);
});

test('IP hashes are stable and do not contain the address', async () => {
  const first = await hashIp('203.0.113.9');
  const second = await hashIp('203.0.113.9');
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first.includes('203.0.113.9'), false);
  assert.notEqual(first, await hashIp('203.0.113.10'));
});

test('file names lose paths and control characters', () => {
  assert.equal(sanitizeFileName('..\\folder\\notes.txt'), 'notes.txt');
  assert.equal(sanitizeFileName('bad\u0000name.md'), 'badname.md');
  assert.equal(sanitizeFileName(''), '');
});

test('chunking preserves page numbers and overlap', () => {
  const chunks = chunkPages('doc-1', 'notes.txt', [
    [null, '第一段内容。\n\n第二段内容。'],
  ], { chunkSize: 8, overlap: 2 });
  assert.equal(chunks[0].page, null);
  assert.equal(chunks[0].chunk_index, 0);
  assert.equal(chunks[0].id, 'doc-1:0');
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.every((chunk) => chunk.text.length <= 8), true);
  assert.equal(chunks.every((chunk) => chunk.text.trim().length > 0), true);
});

test('chunking without paragraph boundaries starts the next chunk with the overlap', () => {
  const text = '字'.repeat(900);
  const chunks = chunkPages('doc-overlap', 'overlap.txt', [[null, text]], {});
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, text.slice(0, 600));
  assert.equal(chunks[1].text, text.slice(520));
  assert.equal(chunks[1].text.startsWith(Array.from(chunks[0].text).slice(-80).join('')), true);
  assert.equal(chunks.every((chunk) => chunk.text.trim().length > 0), true);
});

test('chunking keeps page numbers distinct across pages', () => {
  const chunks = chunkPages('doc-pages', 'pages.txt', [
    [1, '甲甲甲甲甲甲甲甲'],
    [5, '乙乙乙乙乙乙乙乙乙'],
  ], { chunkSize: 10, overlap: 2 });
  assert.deepEqual(chunks.map((chunk) => chunk.page), [1, 5]);
  assert.deepEqual(chunks.map((chunk) => chunk.chunk_index), [0, 1]);
  assert.deepEqual(chunks.map((chunk) => chunk.id), ['doc-pages:0', 'doc-pages:1']);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['甲甲甲甲甲甲甲甲', '乙乙乙乙乙乙乙乙乙']);
  assert.equal(chunks.every((chunk) => chunk.text.trim().length > 0), true);
});

test('chunking matches backend code-point boundaries for astral characters', () => {
  assert.equal(Array.from(ASTRAL_TEXT).length, 32);
  const chunks = chunkPages('doc-astral', 'astral.txt', [[1, ASTRAL_TEXT]], {
    chunkSize: 12,
    overlap: 4,
  });
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks.map((chunk) => Array.from(chunk.text).length), [12, 12, 12, 8]);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ASTRAL_CHUNKS);
  assert.equal(chunks.every((chunk) => hasLoneSurrogate(chunk.text) === false), true);
});

test('float16 encoding matches Python struct.pack little-endian', () => {
  // python3 -c "import struct, base64; print(base64.b64encode(b''.join(
  //   struct.pack('<e', value) for value in (1.5, -2.0, 0.125))).decode())"
  // prints AD4AwAAw  (bytes 00 3e 00 c0 00 30)
  const encoded = encodeVector([1.5, -2, 0.125]);
  assert.equal(encoded, 'AD4AwAAw');
  assert.deepEqual([...decodeVector(encoded)], [1.5, -2, 0.125]);
});

test('float16 vectors round-trip within tolerance', () => {
  const vector = [0.1, -0.25, 0.5, 1.5];
  const decoded = decodeVector(encodeVector(vector));
  vector.forEach((value, index) => {
    assert.ok(Math.abs(decoded[index] - value) < 0.01);
  });
  assert.ok(Math.abs(vectorNorm(decoded) - Math.hypot(...vector)) < 0.02);
});

test('AppError serializes only a safe message and code', () => {
  const response = new AppError('daily_limit', '今日额度已用完。', 429).toResponse();
  assert.equal(response.status, 429);
  return response.json().then((body) => {
    assert.deepEqual(body, { detail: '今日额度已用完。', code: 'daily_limit' });
  });
});

test('UniqueConflict is distinguishable from transport failures', () => {
  const conflict = new UniqueConflict();
  assert.equal(conflict instanceof Error, true);
  assert.equal(conflict.name, 'UniqueConflict');
  assert.equal(conflict instanceof AppError, false);
});

test('SHA-256 is hexadecimal and stable', async () => {
  const bytes = new TextEncoder().encode('FindAnswer');
  const digest = await sha256Hex(bytes);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, await sha256Hex(bytes));
});
