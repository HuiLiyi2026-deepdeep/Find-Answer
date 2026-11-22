# FindAnswer Public Qoder Sites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish FindAnswer as one public Qoder Sites link with a shared document library that any visitor can read, upload to and ask, while deletion, model-key management and server secrets remain impossible for visitors.

**Architecture:** A TypeScript/Deno `app` Function owns every public operation. It stores documents, chunks, float16 vectors, reservations and quota counters in Sites Database; original files in Sites Storage; and reads both model keys from server-side Site Secrets. The existing React app gains a public build that calls `/functions/v1/app/api/...`, hides management controls and shows shared-library quota and privacy warnings. The local Python/SQLite/Chroma stack remains unchanged.

**Tech Stack:** React 19, TypeScript, Vite 7, Vitest, Deno-compatible ES modules, Qoder Sites Functions/Database/Storage/Secrets, vendored `unpdf@2.1.0`, Node 24 `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-30-findanswer-design.md`

## Global Constraints

- Public visitors share one library and may read, upload and ask; they may not delete documents, change connections or read/test keys. The backend rejects these operations with HTTP 403 even if the UI is bypassed.
- Limits are exact: 20 MiB per file, 100 eligible files per batch, 30 successful new documents per IP per Asia/Shanghai day, 500 documents total, 5,000 indexed chunks total.
- Operational ingestion bound: one document may produce at most 500 chunks. A larger document fails with a readable error and releases its reservation. This keeps synchronous parsing and embedding inside the Function request budget.
- Supported inputs are TXT, MD, Markdown and textual PDF; no OCR. Duplicate content is detected by SHA-256 and returns HTTP 409 with `detail: "该文件已上传，请勿重复上传。"`.
- Daily/global quota is enforced by unique database slots and reservations, not by in-memory counters. Reservations count while `reserved`, `committing` or `cleaning`; confirmed rows persist; failed uploads release their slot.
- Only a single IP literal taken from an allowlisted `x-qoder-*` header may be trusted. If it is absent or malformed, public uploads fail closed with 403 while Q&A continues.
- Keys live only in server-side Site Secrets. They never appear in source, tests, logs, health responses, browser storage, URLs, command arguments or the conversation. Tests use obviously fake values such as `test-siliconflow-key`.
- No evidence means no DeepSeek call. Missing, invalid, out-of-range, mixed or absent citations make the whole answer a refusal. Citation sources come from stored chunks, never from model text.
- Public Q&A history is never persisted. Questions and retrieved chunks exist only for the current request.
- All expected errors are sanitized Chinese messages with a stable `code`. Raw database, storage, provider and stack details never reach the browser or logs.
- The directory is not a Git repository. Do not commit, merge, push, force-push or create worktrees.
- Do not create a Qoder Site, allocate backend resources, apply a migration, configure Secrets or publish until the user explicitly confirms that cloud step. Do not install Deno or any system dependency without explicit confirmation.
- Never run destructive quota tests against the formal shared library. Use the local harness, and use an isolated test Site only with separate authorization.

---

### Task 1: Add the runtime mode, capabilities and quota contract

**Files:**
- Modify: `backend/app/main.py:98-109`
- Modify: `backend/app/storage.py:45-47`
- Modify: `backend/tests/test_api.py:194-208`
- Modify: `frontend/src/lib/types.ts:1-10`
- Modify: `frontend/src/pages/ConnectionsPage.test.tsx:34-40`
- Modify: `frontend/src/pages/DocumentsPage.test.tsx:12-17` and `:34-38`

**Interfaces:**
- Consumes: existing `create_app()` health endpoint and `LocalStore.count_documents()`.
- Produces: `Health` with `mode: 'local' | 'public'`, `capabilities`, `upload_blocked_reason`, `trusted_ip`, and `quota`. Local mode has no limits; public mode is implemented in Task 8.

- [ ] **Step 1: Write the failing local health test**

Replace the exact-dictionary assertion in `backend/tests/test_api.py` with:

```python
def test_health_reports_configuration_without_secrets(tmp_path):
    client, _ = make_client(tmp_path)

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "mode": "local",
        "capabilities": {
            "upload": True,
            "delete": True,
            "manage_connections": True,
        },
        "upload_blocked_reason": None,
        "trusted_ip": True,
        "siliconflow_configured": False,
        "deepseek_configured": False,
        "models": {"embeddings": "test-embedding", "chat": "test-chat"},
        "document_count": 0,
        "quota": {
            "scope": "local",
            "documents_used": 0,
            "documents_limit": None,
            "chunks_used": 0,
            "chunks_limit": None,
            "daily_uploads_used": None,
            "daily_upload_limit": None,
            "daily_uploads_remaining": None,
        },
    }
    assert "key" not in response.text.lower()
```

Add `count_chunks` to the test `FakeStore` in the same file:

```python
    def count_chunks(self):
        return sum(document["chunk_count"] for document in self.documents)
```

- [ ] **Step 2: Run the test and verify RED**

Run: `python -m pytest tests/test_api.py::test_health_reports_configuration_without_secrets -v` from `backend/`.

Expected: FAIL because the response lacks `mode`, `capabilities`, `trusted_ip` and `quota`.

- [ ] **Step 3: Implement the local contract**

Add to `LocalStore` in `backend/app/storage.py`:

```python
    def count_chunks(self) -> int:
        return self.collection.count()
```

Replace the health return in `backend/app/main.py`:

```python
        documents = store.count_documents()
        chunks = store.count_chunks()
        return {
            "status": "ok",
            "mode": "local",
            "capabilities": {
                "upload": True,
                "delete": True,
                "manage_connections": True,
            },
            "upload_blocked_reason": None,
            "trusted_ip": True,
            "siliconflow_configured": bool(settings.siliconflow_api_key),
            "deepseek_configured": bool(settings.deepseek_api_key),
            "models": {
                "embeddings": settings.embedding_model,
                "chat": settings.chat_model,
            },
            "document_count": documents,
            "quota": {
                "scope": "local",
                "documents_used": documents,
                "documents_limit": None,
                "chunks_used": chunks,
                "chunks_limit": None,
                "daily_uploads_used": None,
                "daily_upload_limit": None,
                "daily_uploads_remaining": None,
            },
        }
```

Add the shared frontend types at the top of `frontend/src/lib/types.ts`:

```ts
export type RuntimeMode = 'local' | 'public';

export interface Capabilities {
  upload: boolean;
  delete: boolean;
  manage_connections: boolean;
}

export interface Quota {
  scope: 'local' | 'shared';
  documents_used: number;
  documents_limit: number | null;
  chunks_used: number;
  chunks_limit: number | null;
  daily_uploads_used: number | null;
  daily_upload_limit: number | null;
  daily_uploads_remaining: number | null;
}

export interface Health {
  status: 'ok';
  mode: RuntimeMode;
  capabilities: Capabilities;
  upload_blocked_reason: string | null;
  trusted_ip: boolean;
  siliconflow_configured: boolean;
  deepseek_configured: boolean;
  models: {
    embeddings: string;
    chat: string;
  };
  document_count: number;
  quota: Quota;
}
```

Update the two frontend health fixtures by appending these fields. For `ConnectionsPage.test.tsx`:

```ts
      mode: 'local',
      capabilities: { upload: true, delete: true, manage_connections: true },
      upload_blocked_reason: null,
      trusted_ip: true,
      quota: {
        scope: 'local',
        documents_used: 0,
        documents_limit: null,
        chunks_used: 0,
        chunks_limit: null,
        daily_uploads_used: null,
        daily_upload_limit: null,
        daily_uploads_remaining: null,
      },
```

Use the same block inside `healthResponse()` in `DocumentsPage.test.tsx` and in the inline health responses at lines 34-38.

- [ ] **Step 4: Run backend and frontend checks**

Run: `python -m pytest tests/test_api.py -v` from `backend/`.

Expected: all API tests pass.

Run: `npm test` from `frontend/`.

Expected: all existing tests pass with the updated fixtures.

Run: `npm run build` from `frontend/`.

Expected: TypeScript build exits 0.

---

### Task 2: Build the Function primitives

**Files:**
- Create: `functions/errors.mjs`
- Create: `functions/config.mjs`
- Create: `functions/client-ip.mjs`
- Create: `functions/text.mjs`
- Test: `public-harness/tests/primitives.test.mjs`

**Interfaces:**
- Consumes: Web-standard `Request`, `crypto.subtle`, `TextEncoder`, `TextDecoder`, `btoa`/`atob`, `Intl`.
- Produces: `AppError`, `fail`, `UniqueConflict`, `LIMITS`, `MODELS`, `trustedClientIp`, `hashIp`, `dayKey`, `sanitizeFileName`, `validateUploadName`, `sha256Hex`, `decodeUtf8`, `chunkPages`, `encodeVector`, `decodeVector`, `vectorNorm`.

- [ ] **Step 1: Write failing primitive tests**

Create `public-harness/tests/primitives.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dayKey, hashIp, isIpLiteral, trustedClientIp,
} from '../../functions/client-ip.mjs';
import { AppError, UniqueConflict } from '../../functions/errors.mjs';
import {
  chunkPages, decodeVector, encodeVector, sanitizeFileName, sha256Hex, vectorNorm,
} from '../../functions/text.mjs';

test('Shanghai day keys cross the UTC boundary', () => {
  assert.equal(dayKey(new Date('2026-10-30T15:59:59Z')), '2026-10-30');
  assert.equal(dayKey(new Date('2026-10-30T16:00:00Z')), '2026-10-31');
});

test('only allowlisted x-qoder headers with one IP literal are trusted', () => {
  assert.equal(isIpLiteral('203.0.113.9'), true);
  assert.equal(isIpLiteral('2001:db8::1'), true);
  assert.equal(isIpLiteral('not-an-ip'), false);
  assert.equal(isIpLiteral('203.0.113.9:443'), false);

  const trusted = new Request('https://site.test/api/health', {
    headers: { 'x-qoder-client-ip': '203.0.113.9' },
  });
  assert.deepEqual(trustedClientIp(trusted), {
    ip: '203.0.113.9', source: 'x-qoder-client-ip',
  });

  const spoofed = new Request('https://site.test/api/health', {
    headers: { 'x-forwarded-for': '198.51.100.4' },
  });
  assert.equal(trustedClientIp(spoofed), null);

  const malformed = new Request('https://site.test/api/health', {
    headers: { 'x-qoder-client-ip': 'unknown' },
  });
  assert.equal(trustedClientIp(malformed), null);
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
  assert.equal(new UniqueConflict() instanceof Error, true);
});

test('SHA-256 is hexadecimal and stable', async () => {
  const bytes = new TextEncoder().encode('FindAnswer');
  const digest = await sha256Hex(bytes);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, await sha256Hex(bytes));
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test public-harness/tests/primitives.test.mjs` from the project root.

Expected: FAIL because `functions/errors.mjs` does not exist.

- [ ] **Step 3: Implement the primitive modules**

Create `functions/errors.mjs`:

```js
export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }

  toResponse() {
    return Response.json(
      { detail: this.message, code: this.code },
      { status: this.status, headers: { 'cache-control': 'no-store' } },
    );
  }
}

export class UniqueConflict extends Error {
  constructor() {
    super('unique constraint conflict');
    this.name = 'UniqueConflict';
  }
}

export function fail(code, message, status = 400) {
  throw new AppError(code, message, status);
}
```

Create `functions/config.mjs`:

```js
export const MODELS = Object.freeze({
  embeddings: 'BAAI/bge-m3',
  chat: 'deepseek-chat',
});

export const LIMITS = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxUploadBodyBytes: 21 * 1024 * 1024,
  maxBatchFiles: 100,
  dailyUploads: 30,
  maxDocuments: 500,
  maxChunks: 5000,
  maxChunksPerDocument: 500,
  chunkSize: 600,
  chunkOverlap: 80,
  defaultTopK: 5,
  scoreThreshold: 0.25,
  embeddingBatchSize: 32,
  leaseMs: 120000,
  processingBudgetMs: 50000,
  maxQuestionLength: 2000,
  maxJsonBytes: 8192,
  reservationRetries: 4,
});
```

Create `functions/client-ip.mjs`:

```js
const IP_HEADERS = [
  'x-qoder-client-ip',
  'x-qoder-forwarded-for',
  'x-qoder-real-ip',
];

const shanghaiDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function validIpv4(value) {
  const parts = value.split('.');
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function validIpv6(value) {
  if (!value.includes(':') || value.includes('%')) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}

export function isIpLiteral(value) {
  return typeof value === 'string'
    && (validIpv4(value) || validIpv6(value));
}

export function trustedClientIp(request) {
  for (const name of IP_HEADERS) {
    const raw = request.headers.get(name);
    if (raw === null) continue;
    const candidate = raw.split(',')[0].trim();
    if (!isIpLiteral(candidate)) return null;
    return { ip: candidate.toLowerCase(), source: name };
  }
  return null;
}

export async function hashIp(ip) {
  const bytes = new TextEncoder().encode(`findanswer:public-ip:v1:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export function dayKey(date) {
  return shanghaiDay.format(date);
}
```

Create `functions/text.mjs` with the complete code below. It ports the Python chunker exactly and implements float16 storage.

```js
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
    const paragraphEnds = [];
    const paragraphPattern = /\n\s*\n/g;
    let match;
    while ((match = paragraphPattern.exec(text)) !== null) {
      paragraphEnds.push(match.index);
    }

    let start = 0;
    let previousEnd = 0;
    while (start < text.length) {
      const maximumEnd = Math.min(start + chunkSize, text.length);
      let end;
      if (maximumEnd === text.length) {
        end = maximumEnd;
      } else {
        const candidateIndex = bisectRight(paragraphEnds, maximumEnd) - 1;
        end = candidateIndex >= 0 && paragraphEnds[candidateIndex] > previousEnd
          ? paragraphEnds[candidateIndex]
          : maximumEnd;
      }

      let contentStart = start;
      let contentEnd = end;
      while (contentStart < contentEnd && /\s/.test(text[contentStart])) contentStart += 1;
      while (contentEnd > contentStart && /\s/.test(text[contentEnd - 1])) contentEnd -= 1;
      if (contentStart < contentEnd) append(page, text.slice(contentStart, contentEnd));

      if (end === text.length) break;
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
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run: `node --test public-harness/tests/primitives.test.mjs` from the project root.

Expected: 9 tests pass.

- [ ] **Step 5: Recheck the local suite**

Run: `python -m pytest tests/test_api.py -v` from `backend/` and `npm test` from `frontend/`.

Expected: both stay green; this task does not modify application behavior.

---

### Task 3: Add textual PDF extraction with a vendored serverless parser

**Files:**
- Create: `functions/vendor/unpdf/**`
- Create: `functions/pdf.mjs`
- Create: `functions/extract.mjs`
- Create: `public-harness/fixtures/make-pdf.mjs`
- Create: `public-harness/tests/pdf.test.mjs`

**Interfaces:**
- Consumes: `extractText` and `getDocumentProxy` from `unpdf`; `decodeUtf8` from `text.mjs`.
- Produces: `extractPdfPages(bytes): Promise<Array<[number, string]>>` and `extractPages(name, bytes): Promise<Array<[number|null, string]>>`.

- [ ] **Step 1: Vendor `unpdf` without installing it globally**

Run from the project root:

```bash
mkdir -p .runtime/vendor
npm pack unpdf@2.1.0 --pack-destination .runtime/vendor
tar -xzf .runtime/vendor/unpdf-2.1.0.tgz -C .runtime/vendor
mkdir -p functions/vendor/unpdf
cp -R .runtime/vendor/package/. functions/vendor/unpdf/
node -e "import('./functions/vendor/unpdf/dist/index.mjs').then(m => console.log(typeof m.extractText, typeof m.getDocumentProxy))"
```

Expected: the last command prints `function function`. If `npm pack` fails, stop and report the dependency blocker; do not replace the parser with a remote runtime import.

- [ ] **Step 2: Write the failing PDF test**

Create `public-harness/fixtures/make-pdf.mjs`:

```js
export function makeTextPdf(text) {
  const safe = text.replace(/[()\\]/g, (value) => `\\${value}`);
  const stream = `BT /F1 18 Tf 72 720 Td (${safe}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
```

Create `public-harness/tests/pdf.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPages } from '../../functions/extract.mjs';
import { makeTextPdf } from '../fixtures/make-pdf.mjs';

test('extracts page text from a textual PDF', async () => {
  const pages = await extractPages('fixture.pdf', makeTextPdf('FindAnswer public PDF fixture'));
  assert.equal(pages.length, 1);
  assert.equal(pages[0][0], 1);
  assert.match(pages[0][1], /FindAnswer public PDF fixture/);
});

test('extracts UTF-8 text and rejects invalid bytes', async () => {
  const pages = await extractPages('notes.md', new TextEncoder().encode('第一段\n\n第二段'));
  assert.deepEqual(pages, [[null, '第一段\n\n第二段']]);
  await assert.rejects(
    () => extractPages('notes.txt', new Uint8Array([0xff, 0xfe, 0x00])),
    (error) => error.code === 'invalid_encoding',
  );
});

test('rejects a corrupt PDF with a safe message', async () => {
  await assert.rejects(
    () => extractPages('broken.pdf', new TextEncoder().encode('not a pdf')),
    (error) => error.code === 'invalid_pdf'
      && error.message === 'PDF 无法解析，请上传包含可选文字的有效 PDF。',
  );
});
```

- [ ] **Step 3: Run the test and verify RED**

Run: `node --test public-harness/tests/pdf.test.mjs` from the project root.

Expected: FAIL because `functions/extract.mjs` does not exist.

- [ ] **Step 4: Implement PDF and unified extraction**

Create `functions/pdf.mjs`:

```js
import { extractText, getDocumentProxy } from './vendor/unpdf/dist/index.mjs';
import { AppError } from './errors.mjs';

export async function extractPdfPages(bytes) {
  try {
    const document = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(document, { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [result.text];
    return pages
      .map((text, index) => [index + 1, String(text ?? '').trim()])
      .filter(([, text]) => text.length > 0);
  } catch {
    throw new AppError(
      'invalid_pdf',
      'PDF 无法解析，请上传包含可选文字的有效 PDF。',
      400,
    );
  }
}
```

Create `functions/extract.mjs`:

```js
import { extractPdfPages } from './pdf.mjs';
import { decodeUtf8, extensionOf } from './text.mjs';

export async function extractPages(name, bytes) {
  if (extensionOf(name) === '.pdf') return extractPdfPages(bytes);
  const text = decodeUtf8(bytes);
  return text ? [[null, text]] : [];
}
```

If the vendored export name differs, inspect `functions/vendor/unpdf/dist/index.mjs` and adjust only the import; do not add a runtime CDN import.

- [ ] **Step 5: Run the PDF tests**

Run: `node --test public-harness/tests/pdf.test.mjs` from the project root.

Expected: 3 tests pass. If the generated fixture cannot be parsed, fix the fixture generator, not the production parser, until a valid PDF verifies real extraction.

---

### Task 4: Define the database schema and repository

**Files:**
- Create: `deploy/schema.sql`
- Create: `functions/repository.mjs`
- Create: `public-harness/in-memory-repository.mjs`
- Test: `public-harness/tests/repository.test.mjs`

**Interfaces:**
- Consumes: an injected Supabase-style client `db` from `createDatabaseClient()`.
- Produces: `createRepository(db)` with document, chunk, reservation and batch-attempt methods; `UniqueConflict` on unique violations; normalized numeric fields.

- [ ] **Step 1: Write the schema source of truth**

Create `deploy/schema.sql`:

```sql
CREATE TABLE app.documents (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  sha256 text NOT NULL UNIQUE,
  size bigint NOT NULL,
  chunk_count integer NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE app.chunks (
  chunk_key text PRIMARY KEY,
  document_id uuid NOT NULL,
  file_name text NOT NULL,
  page integer,
  chunk_index integer NOT NULL,
  text text NOT NULL,
  embedding text NOT NULL,
  norm text NOT NULL
);
CREATE TABLE app.upload_reservations (
  id uuid PRIMARY KEY,
  ip_slot_key text NOT NULL UNIQUE,
  global_slot integer NOT NULL UNIQUE,
  document_id uuid NOT NULL,
  sha256 text NOT NULL,
  object_path text NOT NULL,
  state text NOT NULL,
  batch_id text NOT NULL,
  ip_day text NOT NULL,
  ip_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  chunk_count integer
);
CREATE TABLE app.upload_batch_attempts (
  attempt_key text PRIMARY KEY,
  batch_id text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX chunks_document_idx ON app.chunks (document_id);
CREATE INDEX reservations_ip_idx ON app.upload_reservations (ip_day, ip_hash);
CREATE INDEX reservations_batch_idx ON app.upload_reservations (batch_id);
CREATE INDEX attempts_batch_idx ON app.upload_batch_attempts (batch_id);
```

- [ ] **Step 2: Write failing repository tests**

Create `public-harness/tests/repository.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepository, isUniqueViolation } from '../../functions/repository.mjs';
import { UniqueConflict } from '../../functions/errors.mjs';

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.calls = [];
  }

  select(columns, options) { this.calls.push(['select', columns, options]); return this; }
  order(column, options) { this.calls.push(['order', column, options]); return this; }
  limit(value) { this.calls.push(['limit', value]); return this; }
  range(from, to) { this.calls.push(['range', from, to]); return this; }
  eq(column, value) { this.calls.push(['eq', column, value]); return this; }
  in(column, values) { this.calls.push(['in', column, values]); return this; }
  lt(column, value) { this.calls.push(['lt', column, value]); return this; }
  insert(values) { this.calls.push(['insert', values]); return this; }
  update(values) { this.calls.push(['update', values]); return this; }
  delete() { this.calls.push(['delete']); return this; }
  then(resolve, reject) {
    return Promise.resolve(this.db.next(this.table, this.calls)).then(resolve, reject);
  }
}

class FakeDb {
  constructor(results) {
    this.results = results;
    this.queries = [];
  }

  from(table) {
    const query = new FakeQuery(this, table);
    this.queries.push(query);
    return query;
  }

  next(table) {
    const queue = this.results[table];
    if (!queue || queue.length === 0) return { data: [], error: null };
    const value = queue.shift();
    return value instanceof Error ? { data: null, error: value } : value;
  }
}

test('unique violations map to UniqueConflict', async () => {
  assert.equal(isUniqueViolation({ code: '23505' }), true);
  assert.equal(isUniqueViolation({ code: '42501' }), false);
  assert.equal(isUniqueViolation(null), false);

  const db = new FakeDb({
    documents: [{ data: null, error: { code: '23505' } }],
  });
  const repository = createRepository(db);
  await assert.rejects(
    () => repository.insertDocument({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'a.txt', sha256: 'a', size: 1, chunk_count: 1,
      created_at: '2026-10-30T00:00:00Z',
    }),
    UniqueConflict,
  );
});

test('chunk pagination reads 1000-row pages until the last short page', async () => {
  const first = Array.from({ length: 1000 }, (_, index) => ({ chunk_key: `c${index}` }));
  const second = [{ chunk_key: 'c1000' }];
  const db = new FakeDb({
    chunks: [{ data: first, error: null }, { data: second, error: null }],
  });
  const repository = createRepository(db);
  const rows = await repository.listAllChunks();
  assert.equal(rows.length, 1001);
  assert.deepEqual(
    db.queries.map((query) => query.calls.find((call) => call[0] === 'range')),
    [['range', 0, 999], ['range', 1000, 1999]],
  );
});

test('reservation updates are conditional on the expected state', async () => {
  const db = new FakeDb({
    upload_reservations: [{ data: [{ id: 'r1', state: 'confirmed' }], error: null }],
  });
  const repository = createRepository(db);
  const updated = await repository.updateReservation('r1', ['reserved'], { state: 'confirmed' });
  assert.equal(updated.state, 'confirmed');
  const calls = db.queries[0].calls;
  assert.deepEqual(calls.find((call) => call[0] === 'eq'), ['eq', 'id', 'r1']);
  assert.deepEqual(calls.find((call) => call[0] === 'in'), ['in', 'state', ['reserved']]);
});

test('documents normalize bigint and integer fields to numbers', async () => {
  const db = new FakeDb({
    documents: [{
      data: [{
        id: 'd1', name: 'a.txt', sha256: 'a', size: '12', chunk_count: '2',
        created_at: '2026-10-30T00:00:00Z',
      }],
      error: null,
    }],
  });
  const repository = createRepository(db);
  const [document] = await repository.listDocuments();
  assert.equal(document.size, 12);
  assert.equal(document.chunk_count, 2);
});
```

- [ ] **Step 3: Run the tests and verify RED**

Run: `node --test public-harness/tests/repository.test.mjs` from the project root.

Expected: FAIL because `functions/repository.mjs` does not exist.

- [ ] **Step 4: Implement the repository**

Create `functions/repository.mjs`:

```js
import { UniqueConflict } from './errors.mjs';

export class RepositoryError extends Error {
  constructor(code) {
    super('repository operation failed');
    this.name = 'RepositoryError';
    this.code = code;
  }
}

export function isUniqueViolation(error) {
  return Boolean(error) && error.code === '23505';
}

function unwrap(result) {
  if (result?.error) throw new RepositoryError(result.error.code ?? 'unknown');
  return result?.data ?? [];
}

function documentRow(row) {
  return {
    id: row.id,
    name: row.name,
    sha256: row.sha256,
    size: Number(row.size),
    chunk_count: Number(row.chunk_count),
    created_at: row.created_at,
  };
}

function reservationRow(row) {
  return {
    ...row,
    global_slot: Number(row.global_slot),
    chunk_count: row.chunk_count === null ? null : Number(row.chunk_count),
  };
}

export function createRepository(db) {
  return {
    async listDocuments() {
      const rows = unwrap(await db.from('documents')
        .select('id,name,sha256,size,chunk_count,created_at')
        .order('created_at', { ascending: false })
        .limit(500));
      return rows.map(documentRow);
    },

    async getDocument(id) {
      const rows = unwrap(await db.from('documents')
        .select('id,name,sha256,size,chunk_count,created_at')
        .eq('id', id)
        .limit(1));
      return rows.length ? documentRow(rows[0]) : null;
    },

    async findDocumentByHash(sha256) {
      const rows = unwrap(await db.from('documents')
        .select('id,name,sha256,size,chunk_count,created_at')
        .eq('sha256', sha256)
        .limit(1));
      return rows.length ? documentRow(rows[0]) : null;
    },

    async listChunks(documentId) {
      return unwrap(await db.from('chunks')
        .select('chunk_key,document_id,file_name,page,chunk_index,text,embedding,norm')
        .eq('document_id', documentId)
        .order('chunk_index', { ascending: true })
        .limit(500));
    },

    async listAllChunks() {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const page = unwrap(await db.from('chunks')
          .select('chunk_key,document_id,file_name,page,chunk_index,text,embedding,norm')
          .order('chunk_key', { ascending: true })
          .range(from, from + 999));
        rows.push(...page);
        if (page.length < 1000) return rows;
      }
    },

    async insertDocument(document) {
      const result = await db.from('documents').insert(document);
      if (result?.error) {
        if (isUniqueViolation(result.error)) throw new UniqueConflict();
        throw new RepositoryError(result.error.code ?? 'unknown');
      }
    },

    async insertChunks(chunks) {
      for (let start = 0; start < chunks.length; start += 100) {
        const batch = chunks.slice(start, start + 100);
        const result = await db.from('chunks').insert(batch);
        if (result?.error) {
          if (isUniqueViolation(result.error)) throw new UniqueConflict();
          throw new RepositoryError(result.error.code ?? 'unknown');
        }
      }
    },

    async deleteChunks(documentId) {
      unwrap(await db.from('chunks').delete().eq('document_id', documentId));
    },

    async deleteDocument(id) {
      unwrap(await db.from('documents').delete().eq('id', id));
    },

    async listReservations() {
      const rows = unwrap(await db.from('upload_reservations')
        .select('id,ip_slot_key,global_slot,document_id,sha256,object_path,state,batch_id,ip_day,ip_hash,created_at,updated_at,expires_at,chunk_count')
        .limit(1000));
      return rows.map(reservationRow);
    },

    async getReservation(id) {
      const rows = unwrap(await db.from('upload_reservations')
        .select('id,ip_slot_key,global_slot,document_id,sha256,object_path,state,batch_id,ip_day,ip_hash,created_at,updated_at,expires_at,chunk_count')
        .eq('id', id)
        .limit(1));
      return rows.length ? reservationRow(rows[0]) : null;
    },

    async insertReservation(row) {
      const result = await db.from('upload_reservations').insert(row);
      if (result?.error) {
        if (isUniqueViolation(result.error)) throw new UniqueConflict();
        throw new RepositoryError(result.error.code ?? 'unknown');
      }
    },

    async updateReservation(id, fromStates, patch) {
      const result = await db.from('upload_reservations')
        .update(patch)
        .eq('id', id)
        .in('state', fromStates)
        .select('id,state,chunk_count')
        .limit(1);
      if (result?.error) throw new RepositoryError(result.error.code ?? 'unknown');
      const rows = result?.data ?? [];
      return rows.length ? reservationRow(rows[0]) : null;
    },

    async deleteReservation(id) {
      unwrap(await db.from('upload_reservations').delete().eq('id', id));
    },

    async listStaleReservations(nowIso, limit = 20) {
      const rows = unwrap(await db.from('upload_reservations')
        .select('id,ip_slot_key,global_slot,document_id,sha256,object_path,state,batch_id,ip_day,ip_hash,created_at,updated_at,expires_at,chunk_count')
        .in('state', ['reserved', 'committing', 'cleaning'])
        .lt('expires_at', nowIso)
        .limit(limit));
      return rows.map(reservationRow);
    },

    async countChunks() {
      const rows = unwrap(await db.from('documents')
        .select('chunk_count')
        .limit(500));
      return rows.reduce((total, row) => total + Number(row.chunk_count), 0);
    },

    async listBatchAttempts(batchId) {
      return unwrap(await db.from('upload_batch_attempts')
        .select('attempt_key')
        .eq('batch_id', batchId)
        .limit(101));
    },

    async insertBatchAttempt(row) {
      const result = await db.from('upload_batch_attempts').insert(row);
      if (result?.error) throw new RepositoryError(result.error.code ?? 'unknown');
    },

    async deleteBatchAttempt(key) {
      unwrap(await db.from('upload_batch_attempts').delete().eq('attempt_key', key));
    },

    async deleteOldAttempts(beforeIso) {
      unwrap(await db.from('upload_batch_attempts').delete().lt('created_at', beforeIso));
    },
  };
}
```

Create `public-harness/in-memory-repository.mjs` with the same interface:

```js
import { UniqueConflict } from '../functions/errors.mjs';

export class InMemoryRepository {
  constructor() {
    this.documents = new Map();
    this.chunks = new Map();
    this.reservations = new Map();
    this.attempts = new Map();
  }

  async listDocuments() {
    return [...this.documents.values()]
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, 500);
  }

  async getDocument(id) { return this.documents.get(id) ?? null; }

  async findDocumentByHash(sha256) {
    return [...this.documents.values()].find((item) => item.sha256 === sha256) ?? null;
  }

  async listChunks(documentId) {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.document_id === documentId)
      .sort((left, right) => left.chunk_index - right.chunk_index);
  }

  async listAllChunks() { return [...this.chunks.values()]; }

  async insertDocument(document) {
    const duplicate = [...this.documents.values()]
      .some((item) => item.sha256 === document.sha256);
    if (duplicate) throw new UniqueConflict();
    this.documents.set(document.id, { ...document });
  }

  async insertChunks(chunks) {
    for (const chunk of chunks) {
      if (this.chunks.has(chunk.chunk_key)) throw new UniqueConflict();
    }
    for (const chunk of chunks) this.chunks.set(chunk.chunk_key, { ...chunk });
  }

  async deleteChunks(documentId) {
    for (const [key, chunk] of this.chunks) {
      if (chunk.document_id === documentId) this.chunks.delete(key);
    }
  }

  async deleteDocument(id) { this.documents.delete(id); }

  async listReservations() { return [...this.reservations.values()]; }

  async getReservation(id) { return this.reservations.get(id) ?? null; }

  async insertReservation(row) {
    const conflict = [...this.reservations.values()].some((item) =>
      item.ip_slot_key === row.ip_slot_key || item.global_slot === row.global_slot);
    if (conflict) throw new UniqueConflict();
    this.reservations.set(row.id, { ...row });
  }

  async updateReservation(id, fromStates, patch) {
    const row = this.reservations.get(id);
    if (!row || !fromStates.includes(row.state)) return null;
    Object.assign(row, patch);
    return { ...row };
  }

  async deleteReservation(id) { this.reservations.delete(id); }

  async listStaleReservations(nowIso, limit = 20) {
    return [...this.reservations.values()]
      .filter((row) => ['reserved', 'committing', 'cleaning'].includes(row.state))
      .filter((row) => row.expires_at < nowIso)
      .slice(0, limit);
  }

  async countChunks() {
    return [...this.documents.values()]
      .reduce((total, document) => total + document.chunk_count, 0);
  }

  async listBatchAttempts(batchId) {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.batch_id === batchId)
      .slice(0, 101);
  }

  async insertBatchAttempt(row) { this.attempts.set(row.attempt_key, { ...row }); }

  async deleteBatchAttempt(key) { this.attempts.delete(key); }

  async deleteOldAttempts(beforeIso) {
    for (const [key, attempt] of this.attempts) {
      if (attempt.created_at < beforeIso) this.attempts.delete(key);
    }
  }
}
```

- [ ] **Step 5: Run repository tests**

Run: `node --test public-harness/tests/repository.test.mjs` from the project root.

Expected: 4 tests pass.

- [ ] **Step 6: Validate the SQL against the supported subset**

Read `deploy/schema.sql` and confirm: only `CREATE TABLE app.<name>`, `CREATE INDEX ... ON app.<name> (...)`; only `boolean`, `integer`, `bigint`, `text`, `uuid`, `timestamptz`, `jsonb`; no `CHECK`, no defaults, no custom functions, no `GRANT`. Do not apply it yet.

---

### Task 5: Implement quota reservations, batch counting and stale recovery

**Files:**
- Create: `functions/quota.mjs`
- Test: `public-harness/tests/quota.test.mjs`

**Interfaces:**
- Consumes: `repository.listReservations()`, `insertReservation()`, `updateReservation()`, `deleteReservation()`, `listStaleReservations()`, `getDocument()`, `deleteChunks()`, `listBatchAttempts()`, `insertBatchAttempt()`, `deleteBatchAttempt()`; `storage.remove([path])`.
- Produces: `createQuota({ repository, storage, clock, limits })` with `reserve`, `heartbeat`, `confirm`, `release`, `markCleaning`, `recoverStale`, `recordBatchAttempt`.

- [ ] **Step 1: Write failing quota tests**

Create `public-harness/tests/quota.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../../functions/config.mjs';
import { createQuota } from '../../functions/quota.mjs';
import { InMemoryRepository } from '../in-memory-repository.mjs';

class FakeStorage {
  constructor() { this.files = new Map(); this.failRemove = false; }
  async upload(path, bytes) { this.files.set(path, bytes); }
  async remove(paths) {
    if (this.failRemove) throw new Error('storage down');
    for (const path of paths) this.files.delete(path);
  }
}

const NOW = new Date('2026-10-30T02:00:00Z');

function setup() {
  const repository = new InMemoryRepository();
  const storage = new FakeStorage();
  const quota = createQuota({ repository, storage, clock: () => NOW, limits: LIMITS });
  return { repository, storage, quota };
}

function reservationInput(index) {
  return {
    documentId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    objectPath: `documents/${index}.txt`,
    sha256: `sha-${index}`,
    batchId: `batch-${index}`,
    ipDay: '2026-10-30',
    ipHash: 'a'.repeat(64),
  };
}

test('the 31st same-IP reservation is rejected without changing the first 30', async () => {
  const { repository, quota } = setup();
  for (let index = 1; index <= 30; index += 1) {
    await quota.reserve(reservationInput(index));
  }
  assert.equal((await repository.listReservations()).length, 30);
  await assert.rejects(
    () => quota.reserve(reservationInput(31)),
    (error) => error.code === 'daily_limit' && error.status === 429,
  );
  assert.equal((await repository.listReservations()).length, 30);
});

test('the 501st global reservation is rejected and slots are reused after release', async () => {
  const { repository, storage, quota } = setup();
  for (let index = 1; index <= 500; index += 1) {
    await quota.reserve({
      ...reservationInput(index),
      ipDay: '2026-10-30',
      ipHash: `ip-${index}`,
    });
  }
  await assert.rejects(
    () => quota.reserve({
      ...reservationInput(501),
      ipHash: 'fresh-ip',
    }),
    (error) => error.code === 'library_full' && error.status === 429,
  );

  const first = (await repository.listReservations())[0];
  await storage.remove([first.object_path]);
  await quota.release(first.id);
  const replacement = await quota.reserve({
    ...reservationInput(501),
    ipHash: 'fresh-ip',
  });
  assert.equal(replacement.global_slot, first.global_slot);
});

test('a batch rejects its 101st eligible attempt and keeps 100', async () => {
  const { repository, quota } = setup();
  for (let index = 1; index <= 100; index += 1) {
    await quota.recordBatchAttempt('one-batch');
  }
  assert.equal((await repository.listBatchAttempts('one-batch')).length, 100);
  await assert.rejects(
    () => quota.recordBatchAttempt('one-batch'),
    (error) => error.code === 'batch_limit' && error.status === 400,
  );
  assert.equal((await repository.listBatchAttempts('one-batch')).length, 100);
});

test('confirm is compare-and-set and heartbeat fails after confirmation', async () => {
  const { quota } = setup();
  const reservation = await quota.reserve(reservationInput(1));
  assert.ok(await quota.confirm(reservation.id, 4));
  assert.equal(await quota.confirm(reservation.id, 4), null);
  assert.equal(await quota.heartbeat(reservation.id), null);
});

test('stale reserved rows without a document are removed with their object', async () => {
  const { repository, storage, quota } = setup();
  const reservation = await quota.reserve(reservationInput(1));
  await storage.upload(reservation.object_path, new Uint8Array([1]));
  await repository.updateReservation(reservation.id, ['reserved'], {
    expires_at: '2026-10-30T01:00:00.000Z',
  });

  await quota.recoverStale();

  assert.equal(await repository.getReservation(reservation.id), null);
  assert.equal(storage.files.has(reservation.object_path), false);
});

test('stale rows with a committed document become confirmed', async () => {
  const { repository, quota } = setup();
  const reservation = await quota.reserve(reservationInput(1));
  await repository.insertDocument({
    id: reservation.document_id,
    name: 'a.txt',
    sha256: reservation.sha256,
    size: 1,
    chunk_count: 3,
    created_at: NOW.toISOString(),
  });
  await repository.updateReservation(reservation.id, ['reserved'], {
    expires_at: '2026-10-30T01:00:00.000Z',
  });

  await quota.recoverStale();

  const recovered = await repository.getReservation(reservation.id);
  assert.equal(recovered.state, 'confirmed');
  assert.equal(recovered.chunk_count, 3);
});

test('failed storage cleanup keeps the slot occupied for a later recovery', async () => {
  const { repository, storage, quota } = setup();
  const reservation = await quota.reserve(reservationInput(1));
  storage.failRemove = true;
  await repository.updateReservation(reservation.id, ['reserved'], {
    expires_at: '2026-10-30T01:00:00.000Z',
  });

  await quota.recoverStale();

  const stillThere = await repository.getReservation(reservation.id);
  assert.equal(stillThere.state, 'cleaning');
  assert.ok(stillThere.expires_at > '2026-10-30T02:00:00.000Z');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test public-harness/tests/quota.test.mjs` from the project root.

Expected: FAIL because `functions/quota.mjs` does not exist.

- [ ] **Step 3: Implement the quota module**

Create `functions/quota.mjs`:

```js
import { LIMITS } from './config.mjs';
import { UniqueConflict, fail } from './errors.mjs';

const ACTIVE_STATES = ['reserved', 'committing', 'cleaning'];

function firstFreeSlot(used, maximum) {
  for (let slot = 1; slot <= maximum; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  return null;
}

export function createQuota({
  repository,
  storage,
  clock = () => new Date(),
  limits = LIMITS,
}) {
  const nowIso = () => clock().toISOString();
  const afterMinutes = (minutes) =>
    new Date(clock().getTime() + minutes * 60000).toISOString();

  async function recoverStale() {
    const stale = await repository.listStaleReservations(nowIso(), 20);
    for (const reservation of stale) {
      const document = await repository.getDocument(reservation.document_id);
      if (document) {
        await repository.updateReservation(
          reservation.id,
          ACTIVE_STATES,
          {
            state: 'confirmed',
            chunk_count: Number(document.chunk_count),
            updated_at: nowIso(),
            expires_at: nowIso(),
          },
        );
        continue;
      }

      try {
        await storage.remove([reservation.object_path]);
        await repository.deleteChunks(reservation.document_id);
        await repository.deleteReservation(reservation.id);
      } catch {
        await repository.updateReservation(
          reservation.id,
          [reservation.state],
          {
            state: 'cleaning',
            updated_at: nowIso(),
            expires_at: afterMinutes(10),
          },
        );
      }
    }
  }

  async function reserve({ documentId, objectPath, sha256, batchId, ipDay, ipHash }) {
    for (let attempt = 0; attempt < limits.reservationRetries; attempt += 1) {
      const reservations = await repository.listReservations();
      const sameIp = reservations.filter(
        (item) => item.ip_day === ipDay && item.ip_hash === ipHash,
      );
      if (sameIp.length >= limits.dailyUploads) {
        fail('daily_limit', '今日共享上传额度已用完，请明天再试。', 429);
      }
      if (reservations.length >= limits.maxDocuments) {
        fail(
          'library_full',
          '共享资料库已达到 500 份上限，暂时不能上传。',
          429,
        );
      }

      const ipSlots = new Set(
        sameIp.map((item) => Number(item.ip_slot_key.split('|').at(-1))),
      );
      const globalSlots = new Set(
        reservations.map((item) => Number(item.global_slot)),
      );
      const ipSlot = firstFreeSlot(ipSlots, limits.dailyUploads);
      const globalSlot = firstFreeSlot(globalSlots, limits.maxDocuments);
      if (ipSlot === null) {
        fail('daily_limit', '今日共享上传额度已用完，请明天再试。', 429);
      }
      if (globalSlot === null) {
        fail(
          'library_full',
          '共享资料库已达到 500 份上限，暂时不能上传。',
          429,
        );
      }

      const now = nowIso();
      const reservation = {
        id: crypto.randomUUID(),
        ip_slot_key: `${ipDay}|${ipHash}|${ipSlot}`,
        global_slot: globalSlot,
        document_id: documentId,
        sha256,
        object_path: objectPath,
        state: 'reserved',
        batch_id: batchId,
        ip_day: ipDay,
        ip_hash: ipHash,
        created_at: now,
        updated_at: now,
        expires_at: afterMinutes(limits.leaseMs / 60000),
        chunk_count: null,
      };

      try {
        await repository.insertReservation(reservation);
        return reservation;
      } catch (error) {
        if (error instanceof UniqueConflict) continue;
        throw error;
      }
    }
    fail('upload_busy', '共享资料库正忙，请稍后重试。', 503);
  }

  async function heartbeat(id) {
    return repository.updateReservation(id, ['reserved'], {
      updated_at: nowIso(),
      expires_at: afterMinutes(limits.leaseMs / 60000),
    });
  }

  async function confirm(id, chunkCount) {
    return repository.updateReservation(id, ['reserved'], {
      state: 'confirmed',
      chunk_count: chunkCount,
      updated_at: nowIso(),
      expires_at: nowIso(),
    });
  }

  async function release(id) {
    await repository.deleteReservation(id);
  }

  async function markCleaning(id) {
    return repository.updateReservation(id, ['reserved', 'committing'], {
      state: 'cleaning',
      updated_at: nowIso(),
      expires_at: afterMinutes(10),
    });
  }

  async function recordBatchAttempt(batchId) {
    const attempts = await repository.listBatchAttempts(batchId);
    if (attempts.length >= limits.maxBatchFiles) {
      fail('batch_limit', '每批最多上传 100 个合格文件。', 400);
    }
    const attemptKey = `${batchId}:${crypto.randomUUID()}`;
    await repository.insertBatchAttempt({
      attempt_key: attemptKey,
      batch_id: batchId,
      created_at: nowIso(),
    });
    const after = await repository.listBatchAttempts(batchId);
    if (after.length > limits.maxBatchFiles) {
      await repository.deleteBatchAttempt(attemptKey);
      fail('batch_limit', '每批最多上传 100 个合格文件。', 400);
    }
  }

  return {
    reserve,
    heartbeat,
    confirm,
    release,
    markCleaning,
    recoverStale,
    recordBatchAttempt,
  };
}
```

- [ ] **Step 4: Run the quota tests**

Run: `node --test public-harness/tests/quota.test.mjs` from the project root.

Expected: 7 tests pass.

- [ ] **Step 5: Run the earlier Function tests together**

Run: `node --test public-harness/tests/primitives.test.mjs public-harness/tests/repository.test.mjs public-harness/tests/quota.test.mjs` from the project root.

Expected: all pass.

---

### Task 6: Implement model providers and the strict RAG service

**Files:**
- Create: `functions/providers.mjs`
- Create: `functions/rag.mjs`
- Test: `public-harness/tests/rag.test.mjs`

**Interfaces:**
- Consumes: repository `listAllChunks()`; injected `fetchImpl`; stored chunks with `embedding`, `norm`, `text`, `file_name`, `page`, `chunk_index`.
- Produces: `createSiliconFlowEmbeddings`, `createDeepSeekChat`, `createRag`, `NO_RETRIEVAL_ANSWER`, `INSUFFICIENT_EVIDENCE_ANSWER`.

- [ ] **Step 1: Write failing RAG tests**

Create `public-harness/tests/rag.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../../functions/config.mjs';
import {
  createDeepSeekChat, createSiliconFlowEmbeddings,
} from '../../functions/providers.mjs';
import {
  INSUFFICIENT_EVIDENCE_ANSWER, NO_RETRIEVAL_ANSWER, createRag,
} from '../../functions/rag.mjs';
import { encodeVector } from '../../functions/text.mjs';
import { InMemoryRepository } from '../in-memory-repository.mjs';

class FakeEmbeddings {
  constructor(vector = [1, 0]) { this.vector = vector; this.calls = []; }
  async embed(texts) { this.calls.push(texts); return texts.map(() => this.vector); }
}

class FakeChat {
  constructor(answer) { this.answer = answer; this.calls = []; }
  async complete(messages) { this.calls.push(messages); return this.answer; }
}

async function seeded() {
  const repository = new InMemoryRepository();
  await repository.insertDocument({
    id: 'doc-1', name: '资料.txt', sha256: 'sha-1', size: 10,
    chunk_count: 1, created_at: '2026-10-30T00:00:00Z',
  });
  await repository.insertChunks([{
    chunk_key: 'doc-1:0',
    document_id: 'doc-1',
    file_name: '资料.txt',
    page: null,
    chunk_index: 0,
    text: 'FindAnswer 使用真实资料回答。',
    embedding: encodeVector([1, 0]),
    norm: '1',
  }]);
  return repository;
}

test('no chunks returns a refusal without embedding or chat calls', async () => {
  const repository = new InMemoryRepository();
  const embeddings = new FakeEmbeddings();
  const chat = new FakeChat('should not run');
  const rag = createRag({ repository, embeddings, chat, ...LIMITS });
  const result = await rag.ask('有人吗？', 5);
  assert.equal(result.status, 'no_answer');
  assert.equal(result.answer, NO_RETRIEVAL_ANSWER);
  assert.equal(embeddings.calls.length, 0);
  assert.equal(chat.calls.length, 0);
});

test('unrelated vectors fall below the threshold and never call chat', async () => {
  const repository = await seeded();
  const embeddings = new FakeEmbeddings([0, 1]);
  const chat = new FakeChat('[1] 不应调用');
  const rag = createRag({ repository, embeddings, chat, ...LIMITS });
  const result = await rag.ask('无关问题', 5);
  assert.equal(result.status, 'no_answer');
  assert.equal(result.answer, NO_RETRIEVAL_ANSWER);
  assert.equal(chat.calls.length, 0);
});

test('valid citations map to the stored chunk', async () => {
  const repository = await seeded();
  const embeddings = new FakeEmbeddings([1, 0]);
  const chat = new FakeChat('回答依据资料。[1]');
  const rag = createRag({ repository, embeddings, chat, ...LIMITS });
  const result = await rag.ask('FindAnswer 如何回答？', 5);
  assert.equal(result.status, 'answered');
  assert.deepEqual(result.citations, [{
    number: 1,
    chunk_id: 'doc-1:0',
    document_id: 'doc-1',
    file_name: '资料.txt',
    page: null,
    chunk_index: 0,
    text: 'FindAnswer 使用真实资料回答。',
  }]);
});

for (const answer of ['没有引用', '[2] 越界', '[1] 和 [9] 混合', 'NO_ANSWER', '[0] 非法']) {
  test(`refuses the whole answer for ${JSON.stringify(answer)}`, async () => {
    const repository = await seeded();
    const rag = createRag({
      repository,
      embeddings: new FakeEmbeddings([1, 0]),
      chat: new FakeChat(answer),
      ...LIMITS,
    });
    const result = await rag.ask('FindAnswer 如何回答？', 5);
    assert.equal(result.status, 'no_answer');
    assert.equal(result.answer, INSUFFICIENT_EVIDENCE_ANSWER);
    assert.deepEqual(result.citations, []);
  });
}

test('embedding provider validates response order and shape', async () => {
  const provider = createSiliconFlowEmbeddings({
    apiKey: 'test-siliconflow-key',
    model: 'test-model',
    fetchImpl: async () => Response.json({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    }),
  });
  const vectors = await provider.embed(['a', 'b']);
  assert.deepEqual(vectors, [[1, 0], [0, 1]]);

  const invalid = createSiliconFlowEmbeddings({
    apiKey: 'test-siliconflow-key',
    model: 'test-model',
    fetchImpl: async () => Response.json({
      data: [{ index: 0, embedding: [] }],
    }),
  });
  await assert.rejects(
    () => invalid.embed(['a']),
    (error) => error.code === 'embedding_failed' && error.status === 502,
  );
});

test('chat provider sends temperature zero and refuses an empty body', async () => {
  let body;
  const provider = createDeepSeekChat({
    apiKey: 'test-deepseek-key',
    model: 'test-chat',
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: 'OK' } }] });
    },
  });
  assert.equal(await provider.complete([{ role: 'user', content: 'hi' }]), 'OK');
  assert.equal(body.temperature, 0);
  assert.equal(body.stream, false);

  const empty = createDeepSeekChat({
    apiKey: 'test-deepseek-key',
    model: 'test-chat',
    fetchImpl: async () => Response.json({ choices: [{ message: { content: '' } }] }),
  });
  await assert.rejects(() => empty.complete([{ role: 'user', content: 'hi' }]));
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test public-harness/tests/rag.test.mjs` from the project root.

Expected: FAIL because `functions/providers.mjs` and `functions/rag.mjs` do not exist.

- [ ] **Step 3: Implement providers**

Create `functions/providers.mjs`:

```js
import { AppError } from './errors.mjs';

function providerFailure(code, message) {
  return new AppError(code, message, 502);
}

export function createSiliconFlowEmbeddings({
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = 60000,
}) {
  return {
    configured: Boolean(apiKey),
    model,

    async embed(texts) {
      if (!apiKey) {
        throw new AppError(
          'embedding_not_configured',
          '共享资料库的向量服务尚未配置。',
          503,
        );
      }
      try {
        const response = await fetchImpl('https://api.siliconflow.cn/v1/embeddings', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model, input: texts }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error('upstream status');
        const payload = await response.json();
        const rows = [...payload.data].sort((left, right) => left.index - right.index);
        const indices = rows.map((row) => row.index);
        const vectors = rows.map((row) => row.embedding);
        const invalid = indices.length !== texts.length
          || indices.some((index, offset) => index !== offset)
          || vectors.some((vector) => !Array.isArray(vector) || vector.length === 0)
          || new Set(vectors.map((vector) => vector.length)).size > 1
          || vectors.some((vector) => vector.some(
            (value) => typeof value !== 'number' || !Number.isFinite(value),
          ));
        if (invalid) throw new Error('invalid response');
        return vectors;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw providerFailure('embedding_failed', '嵌入服务暂时不可用，请稍后重试。');
      }
    },
  };
}

export function createDeepSeekChat({
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = 90000,
}) {
  return {
    configured: Boolean(apiKey),
    model,

    async complete(messages) {
      if (!apiKey) {
        throw new AppError(
          'chat_not_configured',
          '共享资料库的回答服务尚未配置。',
          503,
        );
      }
      try {
        const response = await fetchImpl('https://api.deepseek.com/chat/completions', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            stream: false,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error('upstream status');
        const payload = await response.json();
        const content = payload.choices[0].message.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('empty response');
        }
        return content.trim();
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw providerFailure('chat_failed', '回答服务暂时不可用，请稍后重试。');
      }
    },
  };
}
```

- [ ] **Step 4: Implement the strict RAG service**

Create `functions/rag.mjs`:

```js
import { LIMITS } from './config.mjs';
import { decodeVector, vectorNorm } from './text.mjs';

export const NO_RETRIEVAL_ANSWER = '你提供的资料中没有这个问题的答案。';
export const INSUFFICIENT_EVIDENCE_ANSWER = '根据你提供的资料，我无法回答这个问题。';

function refusal(retrieval, answer) {
  return {
    status: 'no_answer',
    answer,
    citations: [],
    retrieval,
  };
}

export function createRag({
  repository,
  embeddings,
  chat,
  defaultTopK = LIMITS.defaultTopK,
  scoreThreshold = LIMITS.scoreThreshold,
}) {
  async function retrieve(question, topK = defaultTopK) {
    const cleanQuestion = question.trim();
    const chunks = await repository.listAllChunks();
    if (chunks.length === 0) {
      return {
        question: cleanQuestion,
        top_k: topK,
        score_threshold: scoreThreshold,
        hits: [],
        count: 0,
      };
    }

    const [queryVector] = await embeddings.embed([cleanQuestion]);
    const queryNorm = vectorNorm(queryVector);
    const scored = chunks.map((chunk) => {
      const vector = decodeVector(chunk.embedding);
      const norm = Number(chunk.norm);
      const length = Math.min(queryVector.length, vector.length);
      let dot = 0;
      for (let index = 0; index < length; index += 1) {
        dot += queryVector[index] * vector[index];
      }
      const denominator = queryNorm * norm;
      return {
        id: chunk.chunk_key,
        document_id: chunk.document_id,
        file_name: chunk.file_name,
        page: chunk.page,
        chunk_index: chunk.chunk_index,
        text: chunk.text,
        score: denominator > 0 ? dot / denominator : -1,
      };
    });

    scored.sort((left, right) => right.score - left.score);
    const hits = scored
      .slice(0, topK)
      .filter((hit) => hit.score >= scoreThreshold);
    return {
      question: cleanQuestion,
      top_k: topK,
      score_threshold: scoreThreshold,
      hits,
      count: hits.length,
    };
  }

  async function ask(question, topK = defaultTopK) {
    const retrieval = await retrieve(question, topK);
    const evidence = retrieval.hits;
    if (evidence.length === 0) {
      return refusal(retrieval, NO_RETRIEVAL_ANSWER);
    }

    const numbered = evidence
      .map((chunk, index) => `[${index + 1}] ${chunk.text}`)
      .join('\n\n');
    const messages = [
      {
        role: 'system',
        content: '你是严格的资料问答助手。只能根据用户提供的编号资料片段回答，'
          + '不得使用常识或资料之外的信息。回答时使用资料编号标注引用，'
          + '格式为 [1]、[2]。如果资料不足以回答，只输出 NO_ANSWER，'
          + '不要输出任何其他内容。',
      },
      {
        role: 'user',
        content: `问题：${retrieval.question}\n\n编号资料片段：\n${numbered}`,
      },
    ];
    const answer = (await chat.complete(messages)).trim();
    if (answer.includes('NO_ANSWER')) {
      return refusal(retrieval, INSUFFICIENT_EVIDENCE_ANSWER);
    }

    const citedNumbers = [];
    for (const match of answer.matchAll(/\[(\d+)\]|【(\d+)】/g)) {
      const number = Number(match[1] || match[2]);
      if (!Number.isInteger(number) || number < 1 || number > evidence.length) {
        return refusal(retrieval, INSUFFICIENT_EVIDENCE_ANSWER);
      }
      if (!citedNumbers.includes(number)) citedNumbers.push(number);
    }
    if (citedNumbers.length === 0) {
      return refusal(retrieval, INSUFFICIENT_EVIDENCE_ANSWER);
    }

    return {
      status: 'answered',
      answer,
      citations: citedNumbers.map((number) => {
        const chunk = evidence[number - 1];
        return {
          number,
          chunk_id: chunk.id,
          document_id: chunk.document_id,
          file_name: chunk.file_name,
          page: chunk.page,
          chunk_index: chunk.chunk_index,
          text: chunk.text,
        };
      }),
      retrieval,
    };
  }

  return { retrieve, ask };
}
```

- [ ] **Step 5: Run the RAG tests**

Run: `node --test public-harness/tests/rag.test.mjs` from the project root.

Expected: 11 tests pass (including the five refusal variants).

---

### Task 7: Implement transactional-style ingestion with cleanup

**Files:**
- Create: `functions/ingestion.mjs`
- Test: `public-harness/tests/ingestion.test.mjs`

**Interfaces:**
- Consumes: `repository`, `quota`, `storage.upload/remove`, `embeddings.embed`, `extractPages`, `chunkPages`, `encodeVector`.
- Produces: `createIngestion({ repository, quota, storage, embeddings, clock, randomUUID, limits })` with `ingest({ name, bytes, batchId, ipDay, ipHash })`.

- [ ] **Step 1: Write failing ingestion tests**

Create `public-harness/tests/ingestion.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../../functions/config.mjs';
import { createIngestion } from '../../functions/ingestion.mjs';
import { createQuota } from '../../functions/quota.mjs';
import { InMemoryRepository } from '../in-memory-repository.mjs';

class FakeStorage {
  constructor() { this.files = new Map(); this.failUpload = false; this.failRemove = false; }
  async upload(path, bytes) {
    if (this.failUpload) throw new Error('upload down');
    this.files.set(path, bytes);
  }
  async remove(paths) {
    if (this.failRemove) throw new Error('remove down');
    for (const path of paths) this.files.delete(path);
  }
}

class FakeEmbeddings {
  constructor() { this.calls = 0; this.fail = false; this.delay = 0; }
  async embed(texts) {
    this.calls += 1;
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    if (this.fail) throw new Error('embedding down');
    return texts.map(() => [1, 0]);
  }
}

const NOW = new Date('2026-10-30T02:00:00Z');

function setup(overrides = {}) {
  const repository = overrides.repository ?? new InMemoryRepository();
  const storage = overrides.storage ?? new FakeStorage();
  const embeddings = overrides.embeddings ?? new FakeEmbeddings();
  const clock = overrides.clock ?? (() => NOW);
  const quota = createQuota({ repository, storage, clock, limits: LIMITS });
  const ingestion = createIngestion({
    repository,
    quota,
    storage,
    embeddings,
    clock,
    limits: LIMITS,
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
  });
  return { repository, storage, embeddings, quota, ingestion };
}

function upload(name = 'notes.txt', content = '第一段\n\n第二段') {
  return {
    name,
    bytes: new TextEncoder().encode(content),
    batchId: 'batch-1',
    ipDay: '2026-10-30',
    ipHash: 'a'.repeat(64),
  };
}

test('a successful upload stores the file, chunks, document and confirmed reservation', async () => {
  const { repository, storage, ingestion } = setup();
  const document = await ingestion.ingest(upload());

  assert.equal(document.name, 'notes.txt');
  assert.equal(document.chunk_count, 1);
  assert.equal(repository.documents.size, 1);
  assert.equal(repository.chunks.size, 1);
  assert.equal(storage.files.size, 1);
  const [reservation] = await repository.listReservations();
  assert.equal(reservation.state, 'confirmed');
  assert.equal(reservation.chunk_count, 1);
});

test('a duplicate hash returns 409 before storing anything or consuming quota', async () => {
  const { repository, storage, ingestion } = setup();
  await ingestion.ingest(upload());
  const before = {
    documents: repository.documents.size,
    chunks: repository.chunks.size,
    files: storage.files.size,
    reservations: repository.reservations.size,
  };

  await assert.rejects(
    () => ingestion.ingest({ ...upload(), batchId: 'batch-2' }),
    (error) => error.code === 'duplicate' && error.status === 409
      && error.message === '该文件已上传，请勿重复上传。',
  );
  assert.deepEqual({
    documents: repository.documents.size,
    chunks: repository.chunks.size,
    files: storage.files.size,
    reservations: repository.reservations.size,
  }, before);
});

test('embedding failure removes the file, chunks, document and reservation', async () => {
  const embeddings = new FakeEmbeddings();
  embeddings.fail = true;
  const { repository, storage, ingestion } = setup({ embeddings });

  await assert.rejects(() => ingestion.ingest(upload()));
  assert.equal(repository.documents.size, 0);
  assert.equal(repository.chunks.size, 0);
  assert.equal(storage.files.size, 0);
  assert.equal(repository.reservations.size, 0);
});

test('storage failure releases the reservation', async () => {
  const storage = new FakeStorage();
  storage.failUpload = true;
  const { repository, ingestion } = setup({ storage });

  await assert.rejects(() => ingestion.ingest(upload()));
  assert.equal(repository.reservations.size, 0);
  assert.equal(repository.documents.size, 0);
});

test('a document above 500 chunks is rejected before embedding and releases its slot', async () => {
  const embeddings = new FakeEmbeddings();
  const { repository, ingestion } = setup({ embeddings });
  const content = 'a'.repeat(600 * 501);

  await assert.rejects(
    () => ingestion.ingest(upload('large.txt', content)),
    (error) => error.code === 'document_too_large' && error.status === 400,
  );
  assert.equal(embeddings.calls, 0);
  assert.equal(repository.reservations.size, 0);
  assert.equal(repository.documents.size, 0);
});

test('a unique conflict at document insert is treated as a duplicate and cleaned up', async () => {
  const repository = new InMemoryRepository();
  const originalInsert = repository.insertDocument.bind(repository);
  repository.insertDocument = async (document) => {
    await originalInsert({
      ...document,
      id: '00000000-0000-4000-8000-000000000099',
    });
    throw new Error('simulated race');
  };
  const { storage, ingestion } = setup({ repository });

  await assert.rejects(
    () => ingestion.ingest(upload()),
    (error) => error.code === 'duplicate' && error.status === 409,
  );
  assert.equal(repository.reservations.size, 0);
  assert.equal(storage.files.size, 0);
});

test('a processing deadline stops embedding and cleans up', async () => {
  let ticks = 0;
  const clock = () => new Date(NOW.getTime() + (ticks === 0 ? 0 : 60000));
  const embeddings = new FakeEmbeddings();
  embeddings.embed = async (texts) => {
    ticks += 1;
    return texts.map(() => [1, 0]);
  };
  const { repository, storage, ingestion } = setup({ clock, embeddings });

  await assert.rejects(
    () => ingestion.ingest(upload('long.txt', 'a'.repeat(20000))),
    (error) => error.code === 'processing_timeout',
  );
  assert.equal(repository.documents.size, 0);
  assert.equal(repository.reservations.size, 0);
  assert.equal(storage.files.size, 0);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test public-harness/tests/ingestion.test.mjs` from the project root.

Expected: FAIL because `functions/ingestion.mjs` does not exist.

- [ ] **Step 3: Implement ingestion**

Create `functions/ingestion.mjs`:

```js
import { LIMITS } from './config.mjs';
import { UniqueConflict, fail } from './errors.mjs';
import { extractPages } from './extract.mjs';
import {
  chunkPages, encodeVector, extensionOf, sanitizeFileName,
  sha256Hex, validateUploadName, vectorNorm,
} from './text.mjs';

function contentTypeFor(extension) {
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.md' || extension === '.markdown') {
    return 'text/markdown; charset=utf-8';
  }
  return 'text/plain; charset=utf-8';
}

export function createIngestion({
  repository,
  quota,
  storage,
  embeddings,
  clock = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  limits = LIMITS,
}) {
  async function cleanup(documentId, objectPath, reservationId) {
    let complete = true;
    try { await repository.deleteDocument(documentId); } catch { complete = false; }
    try { await repository.deleteChunks(documentId); } catch { complete = false; }
    try { await storage.remove([objectPath]); } catch { complete = false; }
    if (complete) {
      try { await quota.release(reservationId); } catch { complete = false; }
    }
    if (!complete) {
      await quota.markCleaning(reservationId).catch(() => {});
    }
  }

  async function ingest({ name, bytes, batchId, ipDay, ipHash }) {
    const cleanName = sanitizeFileName(name);
    if (!cleanName) fail('invalid_file_name', '文件名无效。', 400);
    validateUploadName(cleanName);
    if (!bytes.length) fail('empty_file', '文件不能为空。', 400);
    if (bytes.length > limits.maxFileBytes) {
      fail('too_large', '文件大小不能超过 20 MB。', 413);
    }
    if (!batchId || batchId.length > 128) {
      fail('invalid_batch', '批次标识无效。', 400);
    }

    await quota.recoverStale();
    await quota.recordBatchAttempt(batchId);
    await repository
      .deleteOldAttempts(new Date(clock().getTime() - 2 * 86400000).toISOString())
      .catch(() => {});

    const sha256 = await sha256Hex(bytes);
    if (await repository.findDocumentByHash(sha256)) {
      fail('duplicate', '该文件已上传，请勿重复上传。', 409);
    }

    const documentId = randomUUID();
    const objectPath = `documents/${documentId}${extensionOf(cleanName)}`;
    const reservation = await quota.reserve({
      documentId, objectPath, sha256, batchId, ipDay, ipHash,
    });

    const deadline = clock().getTime() + limits.processingBudgetMs;
    const checkDeadline = () => {
      if (clock().getTime() > deadline) {
        fail('processing_timeout', '资料处理超时，请尝试更小的文件。', 503);
      }
    };

    try {
      await storage.upload(objectPath, bytes, {
        contentType: contentTypeFor(extensionOf(cleanName)),
        upsert: false,
      });

      const pages = await extractPages(cleanName, bytes);
      if (pages.length === 0) {
        fail('empty_text', '文件没有可提取的文本内容。', 400);
      }
      const chunks = chunkPages(documentId, cleanName, pages, {
        chunkSize: limits.chunkSize,
        overlap: limits.chunkOverlap,
      });
      if (chunks.length === 0) {
        fail('empty_text', '文件没有可提取的文本内容。', 400);
      }
      if (chunks.length > limits.maxChunksPerDocument) {
        fail(
          'document_too_large',
          '单个文件最多索引 500 个片段，请拆分后再上传。',
          400,
        );
      }

      const usedChunks = await repository.countChunks();
      if (usedChunks + chunks.length > limits.maxChunks) {
        fail(
          'chunk_limit',
          '共享资料库的片段容量已满，暂时不能上传。',
          429,
        );
      }

      const rows = [];
      for (let start = 0; start < chunks.length; start += limits.embeddingBatchSize) {
        checkDeadline();
        const batch = chunks.slice(start, start + limits.embeddingBatchSize);
        const vectors = await embeddings.embed(batch.map((chunk) => chunk.text));
        if (!Array.isArray(vectors) || vectors.length !== batch.length) {
          fail('embedding_failed', '嵌入服务暂时不可用，请稍后重试。', 502);
        }
        batch.forEach((chunk, offset) => {
          const vector = vectors[offset];
          rows.push({
            chunk_key: chunk.id,
            document_id: documentId,
            file_name: cleanName,
            page: chunk.page,
            chunk_index: chunk.chunk_index,
            text: chunk.text,
            embedding: encodeVector(vector),
            norm: String(vectorNorm(vector)),
          });
        });
        if (start + limits.embeddingBatchSize < chunks.length) {
          const alive = await quota.heartbeat(reservation.id);
          if (!alive) {
            fail('upload_interrupted', '上传预留已失效，请重新上传。', 409);
          }
        }
      }
      checkDeadline();

      await repository.insertChunks(rows);
      const document = {
        id: documentId,
        name: cleanName,
        sha256,
        size: bytes.length,
        chunk_count: chunks.length,
        created_at: clock().toISOString(),
      };

      try {
        await repository.insertDocument(document);
      } catch (error) {
        if (error instanceof UniqueConflict) {
          fail('duplicate', '该文件已上传，请勿重复上传。', 409);
        }
        throw error;
      }

      const confirmed = await quota.confirm(reservation.id, chunks.length);
      if (!confirmed) {
        const current = await repository.getReservation(reservation.id);
        if (current?.state === 'confirmed') return document;
        fail('upload_interrupted', '上传预留已失效，请重新上传。', 409);
      }
      return document;
    } catch (error) {
      await cleanup(documentId, objectPath, reservation.id);
      throw error;
    }
  }

  return { ingest };
}
```

- [ ] **Step 4: Run the ingestion tests**

Run: `node --test public-harness/tests/ingestion.test.mjs` from the project root.

Expected: 7 tests pass.

- [ ] **Step 5: Run all Function tests**

Run: `node --test public-harness/tests` from the project root.

Expected: all tests pass.

---

### Task 8: Compose the public service, HTTP routes and Deno entry point

**Files:**
- Create: `functions/service.mjs`
- Create: `functions/routes.mjs`
- Create: `functions/index.ts`
- Create: `public-harness/fakes.mjs`
- Create: `public-harness/server.mjs`
- Test: `public-harness/tests/routes.test.mjs`

**Interfaces:**
- Consumes: all prior modules plus `createDatabaseClient`, `createSiteContext`, `errorResponse` from `./_qoder/backend.mjs`; `createStorageClient` from `./_qoder/storage.mjs`.
- Produces: `createService(...)`, `application({ service, clock, limits })`, and a runnable local harness on `http://127.0.0.1:4174`.

- [ ] **Step 1: Write failing route tests**

Create `public-harness/tests/routes.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../../functions/config.mjs';
import { createService } from '../../functions/service.mjs';
import { application } from '../../functions/routes.mjs';
import { hashIp } from '../../functions/client-ip.mjs';
import { InMemoryRepository } from '../in-memory-repository.mjs';

class FakeStorage {
  constructor() { this.files = new Map(); }
  async upload(path, bytes) { this.files.set(path, bytes); }
  async download(path) {
    if (!this.files.has(path)) throw new Error('not found');
    return new Response(this.files.get(path));
  }
  async remove(paths) { for (const path of paths) this.files.delete(path); }
}

class FakeEmbeddings {
  constructor() { this.configured = true; this.calls = []; }
  async embed(texts) {
    this.calls.push(texts);
    return texts.map((text) => text.includes('无关') ? [0, 1] : [1, 0]);
  }
}

class FakeChat {
  constructor() { this.configured = true; this.calls = []; }
  async complete(messages) { this.calls.push(messages); return '依据资料回答。[1]'; }
}

const NOW = new Date('2026-10-30T02:00:00Z');
const TRUSTED = { 'x-qoder-client-ip': '203.0.113.9' };

function setup() {
  const repository = new InMemoryRepository();
  const storage = new FakeStorage();
  const embeddings = new FakeEmbeddings();
  const chat = new FakeChat();
  const service = createService({
    repository, storage, embeddings, chat,
    clock: () => NOW, limits: LIMITS,
  });
  const app = application({ service, clock: () => NOW, limits: LIMITS });
  return { repository, storage, embeddings, chat, app };
}

function context(request) {
  return { request, requestId: 'request-test' };
}

async function body(response) {
  return response.json();
}

function uploadRequest(name, text, headers = TRUSTED) {
  const form = new FormData();
  form.append('file', new File([text], name, { type: 'text/plain' }));
  form.append('batch_id', 'batch-1');
  return new Request('https://site.test/functions/v1/app/api/documents', {
    method: 'POST', body: form, headers,
  });
}

test('health reports public capabilities and quota without secrets or IP values', async () => {
  const { app } = setup();
  const response = await app(context(new Request(
    'https://site.test/functions/v1/app/api/health',
    { headers: TRUSTED },
  )));
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.equal(payload.mode, 'public');
  assert.deepEqual(payload.capabilities, {
    upload: true, delete: false, manage_connections: false,
  });
  assert.equal(payload.trusted_ip, true);
  assert.equal(payload.quota.scope, 'shared');
  assert.equal(payload.quota.documents_limit, 500);
  assert.equal(payload.quota.daily_uploads_remaining, 30);
  assert.equal(JSON.stringify(payload).includes('203.0.113.9'), false);
  assert.equal(JSON.stringify(payload).toLowerCase().includes('key"'), false);
});

test('health disables uploads but keeps Q&A when no trusted IP is present', async () => {
  const { app } = setup();
  const response = await app(context(new Request(
    'https://site.test/functions/v1/app/api/health',
  )));
  const payload = await body(response);
  assert.equal(payload.capabilities.upload, false);
  assert.equal(payload.trusted_ip, false);
  assert.equal(payload.upload_blocked_reason, '无法确认客户端 IP，暂时不能上传。');
});

test('accepts logical, provider-stripped and physical Function paths', async () => {
  const { app } = setup();
  for (const path of [
    '/functions/v1/app/api/health',
    '/app/api/health',
    '/functions/v1/app-d0123456789abcdef0123456789abcdef/api/health',
  ]) {
    const response = await app(context(new Request(`https://site.test${path}`, {
      headers: TRUSTED,
    })));
    assert.equal(response.status, 200);
  }
});

test('upload returns 201 and a repeated identical file returns the 409 contract', async () => {
  const { app, repository, storage } = setup();
  const first = await app(context(uploadRequest('notes.txt', '第一段\n\n第二段')));
  assert.equal(first.status, 201);
  const document = await body(first);
  assert.equal(document.name, 'notes.txt');
  assert.equal(repository.documents.size, 1);
  assert.equal(storage.files.size, 1);

  const second = await app(context(uploadRequest('notes.txt', '第一段\n\n第二段', {
    ...TRUSTED, 'x-qoder-client-ip': '203.0.113.10',
  })));
  assert.equal(second.status, 409);
  assert.equal((await body(second)).detail, '该文件已上传，请勿重复上传。');
  assert.equal(repository.documents.size, 1);
});

test('upload without a trusted IP fails closed before reading the body', async () => {
  const { app } = setup();
  const response = await app(context(uploadRequest('notes.txt', 'text', {})));
  assert.equal(response.status, 403);
  assert.equal((await body(response)).code, 'upload_unavailable');
});

test('daily quota returns a terminal 429 code and leaves the library empty', async () => {
  const { app, repository } = setup();
  const ipHash = await hashIp('203.0.113.9');
  for (let index = 1; index <= 30; index += 1) {
    repository.reservations.set(`r-${index}`, {
      id: `r-${index}`,
      ip_slot_key: `2026-10-30|ip|${index}`,
      global_slot: index,
      document_id: `d-${index}`,
      sha256: `sha-${index}`,
      object_path: `documents/d-${index}.txt`,
      state: 'confirmed',
      batch_id: `b-${index}`,
      ip_day: '2026-10-30',
      ip_hash: ipHash,
    });
  }
  const response = await app(context(uploadRequest('new.txt', 'new content')));
  assert.equal(response.status, 429);
  const payload = await body(response);
  assert.equal(payload.code, 'daily_limit');
  assert.equal(repository.documents.size, 0);
  assert.equal(repository.reservations.size, 30);
});

test('visitors cannot delete documents or change connections even with a valid body', async () => {
  const { app, repository } = setup();
  repository.documents.set('doc-1', {
    id: 'doc-1', name: 'a.txt', sha256: 'a', size: 1, chunk_count: 1,
    created_at: NOW.toISOString(),
  });

  const deletion = await app(context(new Request(
    'https://site.test/app/api/documents/doc-1', { method: 'DELETE' },
  )));
  assert.equal(deletion.status, 403);

  const connection = await app(context(new Request(
    'https://site.test/app/api/connections/siliconflow',
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: 'should-never-be-used' }),
    },
  )));
  assert.equal(connection.status, 403);
  assert.equal(JSON.stringify(await body(connection)).includes('should-never-be-used'), false);
  assert.equal(repository.documents.size, 1);
});

test('ask refuses without evidence and does not call chat', async () => {
  const { app, chat } = setup();
  const response = await app(context(new Request(
    'https://site.test/app/api/ask',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '没有资料的答案', top_k: 5 }),
    },
  )));
  assert.equal(response.status, 200);
  const payload = await body(response);
  assert.equal(payload.status, 'no_answer');
  assert.equal(payload.answer, '你提供的资料中没有这个问题的答案。');
  assert.equal(chat.calls.length, 0);
});

test('ask returns a mapped citation when evidence exists', async () => {
  const { app } = setup();
  await app(context(uploadRequest('notes.txt', 'FindAnswer 使用真实资料。')));
  const response = await app(context(new Request(
    'https://site.test/app/api/ask',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'FindAnswer 如何回答？' }),
    },
  )));
  const payload = await body(response);
  assert.equal(payload.status, 'answered');
  assert.equal(payload.citations[0].file_name, 'notes.txt');
  assert.equal(payload.citations[0].document_id, payload.retrieval.hits[0].document_id);
});

test('rejects malformed JSON, oversized JSON, unknown paths and wrong methods', async () => {
  const { app } = setup();
  const malformed = await app(context(new Request('https://site.test/app/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  })));
  assert.equal(malformed.status, 400);

  const oversized = await app(context(new Request('https://site.test/app/api/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'x'.repeat(9000) }),
  })));
  assert.equal(oversized.status, 413);

  const unknown = await app(context(new Request('https://site.test/app/api/nope')));
  assert.equal(unknown.status, 404);

  const wrongMethod = await app(context(new Request('https://site.test/app/api/health', {
    method: 'POST',
  })));
  assert.equal(wrongMethod.status, 405);
});

test('unexpected repository failures return a sanitized 500', async () => {
  const { app } = setup();
  const service = { health: async () => { throw new Error('postgres password leaked'); } };
  const isolated = application({ service, clock: () => NOW, limits: LIMITS });
  const response = await isolated(context(new Request('https://site.test/app/api/health')));
  assert.equal(response.status, 500);
  const text = JSON.stringify(await body(response));
  assert.equal(text.includes('postgres'), false);
  assert.equal(text.includes('password'), false);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test public-harness/tests/routes.test.mjs` from the project root.

Expected: FAIL because `functions/service.mjs` and `functions/routes.mjs` do not exist.

- [ ] **Step 3: Implement the service**

Create `functions/service.mjs`:

```js
import { LIMITS } from './config.mjs';
import { AppError } from './errors.mjs';
import { createIngestion } from './ingestion.mjs';
import { createQuota } from './quota.mjs';
import { createRag } from './rag.mjs';
import { dayKey, hashIp } from './client-ip.mjs';

export function createService({
  repository,
  storage,
  embeddings,
  chat,
  clock = () => new Date(),
  limits = LIMITS,
}) {
  const quota = createQuota({ repository, storage, clock, limits });
  const rag = createRag({
    repository,
    embeddings,
    chat,
    defaultTopK: limits.defaultTopK,
    scoreThreshold: limits.scoreThreshold,
  });
  const ingestion = createIngestion({
    repository,
    quota,
    storage,
    embeddings,
    clock,
    limits,
  });

  async function health({ clientIp }) {
    const documents = await repository.listDocuments();
    const reservations = await repository.listReservations();
    const chunks = documents.reduce(
      (total, document) => total + Number(document.chunk_count), 0,
    );
    const day = dayKey(clock());
    const ipHash = clientIp ? await hashIp(clientIp.ip) : null;
    const dailyUsed = ipHash
      ? reservations.filter(
        (item) => item.ip_day === day && item.ip_hash === ipHash,
      ).length
      : 0;

    let blocked = null;
    if (!clientIp) blocked = '无法确认客户端 IP，暂时不能上传。';
    else if (!embeddings.configured) blocked = '共享资料库的向量服务尚未配置。';
    else if (documents.length >= limits.maxDocuments) blocked = '共享资料库已满，暂时不能上传。';
    else if (chunks >= limits.maxChunks) blocked = '共享资料库容量已满，暂时不能上传。';
    else if (dailyUsed >= limits.dailyUploads) blocked = '今日共享上传额度已用完。';

    return {
      status: 'ok',
      mode: 'public',
      capabilities: {
        upload: blocked === null,
        delete: false,
        manage_connections: false,
      },
      upload_blocked_reason: blocked,
      trusted_ip: Boolean(clientIp),
      siliconflow_configured: embeddings.configured,
      deepseek_configured: chat.configured,
      models: {
        embeddings: embeddings.model,
        chat: chat.model,
      },
      document_count: documents.length,
      quota: {
        scope: 'shared',
        documents_used: documents.length,
        documents_limit: limits.maxDocuments,
        chunks_used: chunks,
        chunks_limit: limits.maxChunks,
        daily_uploads_used: dailyUsed,
        daily_upload_limit: limits.dailyUploads,
        daily_uploads_remaining: Math.max(0, limits.dailyUploads - dailyUsed),
      },
    };
  }

  async function listDocuments() {
    return { documents: await repository.listDocuments() };
  }

  async function getChunks(documentId) {
    if (!(await repository.getDocument(documentId))) {
      throw new AppError('not_found', '资料不存在。', 404);
    }
    return {
      document_id: documentId,
      chunks: (await repository.listChunks(documentId)).map((chunk) => ({
        id: chunk.chunk_key,
        document_id: chunk.document_id,
        file_name: chunk.file_name,
        page: chunk.page,
        chunk_index: chunk.chunk_index,
        text: chunk.text,
      })),
    };
  }

  async function ingest({ name, bytes, batchId, clientIp }) {
    if (!clientIp) {
      throw new AppError(
        'upload_unavailable',
        '无法确认客户端 IP，暂时不能上传。',
        403,
      );
    }
    const ipHash = await hashIp(clientIp.ip);
    return ingestion.ingest({
      name,
      bytes,
      batchId,
      ipDay: dayKey(clock()),
      ipHash,
    });
  }

  return {
    health,
    listDocuments,
    getChunks,
    ingest,
    retrieve: (question, topK) => rag.retrieve(question, topK),
    ask: (question, topK) => rag.ask(question, topK),
  };
}
```

- [ ] **Step 4: Implement the HTTP layer**

Create `functions/routes.mjs`:

```js
import { LIMITS } from './config.mjs';
import { AppError, fail } from './errors.mjs';
import { trustedClientIp } from './client-ip.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function methodNotAllowed(allowed) {
  const response = json({ detail: '请求方法不被允许。', code: 'method_not_allowed' }, 405);
  response.headers.set('allow', allowed.join(', '));
  return response;
}

async function readLimited(request, maxBytes) {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    fail('payload_too_large', '请求内容过大。', 413);
  }
  const reader = request.body?.getReader();
  if (!reader) fail('invalid_input', '缺少请求内容。', 400);
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        fail('payload_too_large', '请求内容过大。', 413);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

async function jsonInput(request, limits) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    fail('invalid_input', '请求必须使用 JSON。', 400);
  }
  const bytes = await readLimited(request, limits.maxJsonBytes);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('invalid_input', '请求内容无法解析。', 400);
  }
}

function questionInput(body, limits) {
  if (!body || typeof body !== 'object') {
    fail('invalid_input', '请输入问题。', 400);
  }
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) fail('invalid_input', '请输入问题。', 400);
  if (question.length > limits.maxQuestionLength) {
    fail('invalid_input', '问题不能超过 2000 个字符。', 400);
  }
  const topK = body.top_k === undefined || body.top_k === null
    ? limits.defaultTopK
    : body.top_k;
  if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
    fail('invalid_input', '检索数量必须在 1 到 50 之间。', 400);
  }
  return { question, topK };
}

async function uploadInput(request, limits) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    fail('invalid_input', '请使用文件上传表单。', 415);
  }
  const body = await readLimited(request, limits.maxUploadBodyBytes);
  let form;
  try {
    form = await new Response(body, {
      headers: { 'content-type': contentType },
    }).formData();
  } catch {
    fail('invalid_input', '上传表单无法解析。', 400);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
    fail('invalid_input', '请选择要上传的文件。', 400);
  }
  if (file.size > limits.maxFileBytes) {
    fail('too_large', '文件大小不能超过 20 MB。', 413);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) fail('empty_file', '文件不能为空。', 400);

  const rawBatch = form.get('batch_id');
  if (rawBatch === null) {
    return { name: file.name, bytes, batchId: crypto.randomUUID() };
  }
  if (typeof rawBatch !== 'string' || rawBatch.length < 1 || rawBatch.length > 128) {
    fail('invalid_batch', '批次标识无效。', 400);
  }
  return { name: file.name, bytes, batchId: rawBatch };
}

export function application({ service, clock = () => new Date(), limits = LIMITS }) {
  return async function handle(ctx) {
    try {
      const request = ctx.request;
      const pathname = new URL(request.url).pathname;
      const match = pathname.match(
        /^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/,
      );
      if (!match) fail('not_found', '接口不存在。', 404);
      const path = match[1] || '/';
      const method = request.method;

      if (path === '/api/health') {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        return json(await service.health({
          clientIp: trustedClientIp(request),
        }));
      }

      if (path === '/api/documents') {
        if (method === 'GET') return json(await service.listDocuments());
        if (method !== 'POST') return methodNotAllowed(['GET', 'POST']);
        const clientIp = trustedClientIp(request);
        if (!clientIp) {
          fail('upload_unavailable', '无法确认客户端 IP，暂时不能上传。', 403);
        }
        const upload = await uploadInput(request, limits);
        const document = await service.ingest({ ...upload, clientIp });
        return json(document, 201);
      }

      const chunksPath = path.match(/^\/api\/documents\/([^/]+)\/chunks$/);
      if (chunksPath) {
        if (method !== 'GET') return methodNotAllowed(['GET']);
        if (!UUID.test(chunksPath[1])) fail('not_found', '资料不存在。', 404);
        return json(await service.getChunks(chunksPath[1]));
      }

      if (/^\/api\/documents\/[^/]+$/.test(path)) {
        if (method !== 'DELETE') return methodNotAllowed(['DELETE']);
        fail('forbidden', '公开共享库不允许删除资料。', 403);
      }

      if (path === '/api/search' || path === '/api/ask') {
        if (method !== 'POST') return methodNotAllowed(['POST']);
        const { question, topK } = questionInput(
          await jsonInput(request, limits),
          limits,
        );
        const result = path === '/api/search'
          ? await service.retrieve(question, topK)
          : await service.ask(question, topK);
        return json(result);
      }

      if (path === '/api/connections/siliconflow' || path === '/api/connections/deepseek') {
        if (method !== 'PUT') return methodNotAllowed(['PUT']);
        fail('forbidden', '公开版不允许修改模型连接。', 403);
      }

      if (path.startsWith('/api/connections/')) {
        if (method === 'PUT') fail('forbidden', '公开版不允许修改模型连接。', 403);
        return methodNotAllowed(['PUT']);
      }

      fail('not_found', '接口不存在。', 404);
    } catch (error) {
      if (error instanceof AppError) return error.toResponse();
      console.error('findanswer_request_failed', {
        requestId: ctx.requestId ?? null,
        name: error instanceof Error ? error.name : 'unknown',
      });
      return json({ detail: '服务暂时不可用，请稍后重试。', code: 'internal_error' }, 500);
    }
  };
}
```

- [ ] **Step 5: Implement the Deno entry point**

Create `functions/index.ts`:

```ts
import {
  createDatabaseClient,
  createSiteContext,
  errorResponse,
} from './_qoder/backend.mjs';
import { createStorageClient } from './_qoder/storage.mjs';
import { LIMITS, MODELS } from './config.mjs';
import { createDeepSeekChat, createSiliconFlowEmbeddings } from './providers.mjs';
import { createRepository } from './repository.mjs';
import { application } from './routes.mjs';
import { createService } from './service.mjs';

const repository = createRepository(createDatabaseClient());
const storage = createStorageClient();
const embeddings = createSiliconFlowEmbeddings({
  apiKey: (Deno.env.get('SILICONFLOW_API_KEY') ?? '').trim(),
  model: MODELS.embeddings,
});
const chat = createDeepSeekChat({
  apiKey: (Deno.env.get('DEEPSEEK_API_KEY') ?? '').trim(),
  model: MODELS.chat,
});
const service = createService({
  repository,
  storage,
  embeddings,
  chat,
  limits: LIMITS,
});
const handle = application({ service, limits: LIMITS });

Deno.serve(async (request) => {
  let context;
  try {
    context = createSiteContext(request);
    return await handle(context);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
```

The `_qoder` directory is injected at deployment. Never create it in source and never add it to the Function package.

- [ ] **Step 6: Create the local harness fakes and server**

Create `public-harness/fakes.mjs`:

```js
import { AppError } from '../functions/errors.mjs';

export class FakeStorage {
  constructor() { this.files = new Map(); }
  async upload(path, bytes) { this.files.set(path, bytes); }
  async download(path) {
    if (!this.files.has(path)) throw new AppError('not_found', '文件不存在。', 404);
    return new Response(this.files.get(path));
  }
  async remove(paths) { for (const path of paths) this.files.delete(path); }
}

function vectorFor(text) {
  const vector = new Float64Array(64);
  const value = String(text).toLowerCase();
  for (let index = 0; index < value.length - 1; index += 1) {
    const code = value.charCodeAt(index) + value.charCodeAt(index + 1) * 7;
    vector[code % vector.length] += 1;
  }
  const norm = Math.hypot(...vector);
  return norm ? [...vector].map((item) => item / norm) : [...vector];
}

export class FakeEmbeddings {
  constructor() { this.configured = true; this.model = 'fake-embedding'; }
  async embed(texts) { return texts.map(vectorFor); }
}

export class FakeChat {
  constructor() { this.configured = true; this.model = 'fake-chat'; }
  async complete() { return '根据共享资料，可以这样回答。[1]'; }
}
```

Create `public-harness/server.mjs`:

```js
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { LIMITS } from '../functions/config.mjs';
import { application } from '../functions/routes.mjs';
import { createService } from '../functions/service.mjs';
import { InMemoryRepository } from './in-memory-repository.mjs';
import { FakeChat, FakeEmbeddings, FakeStorage } from './fakes.mjs';

const port = Number(process.argv[2] ?? 4174);
const root = new URL('../frontend/dist-public/', import.meta.url).pathname;
const repository = new InMemoryRepository();
const service = createService({
  repository,
  storage: new FakeStorage(),
  embeddings: new FakeEmbeddings(),
  chat: new FakeChat(),
  limits: LIMITS,
});
const handle = application({ service, limits: LIMITS });

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

async function staticFile(pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  let path = join(root, safe);
  try {
    const info = await stat(path);
    if (info.isDirectory()) path = join(path, 'index.html');
  } catch {
    path = join(root, 'index.html');
  }
  try {
    return new Response(await readFile(path), {
      headers: { 'content-type': types[extname(path)] ?? 'application/octet-stream' },
    });
  } catch {
    return new Response('Build the public frontend first.', { status: 404 });
  }
}

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const isApi = request.url.startsWith('/functions/v1/app/') || request.url.startsWith('/app/api/');
  try {
    let result;
    if (isApi) {
      const webRequest = new Request(`http://127.0.0.1:${port}${request.url}`, {
        method: request.method,
        headers: request.headers,
        body: body.length ? body : undefined,
      });
      result = await handle({ request: webRequest, requestId: 'local-harness' });
    } else {
      result = await staticFile(new URL(request.url, `http://127.0.0.1:${port}`).pathname);
    }
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ detail: '本地测试服务出错。', code: 'harness_error' }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`FindAnswer public harness: http://127.0.0.1:${port}`);
});
```

The harness uses in-memory storage and deterministic fake providers. It is not deployment code, never packaged, and must be described as local fixture data in any handoff.

- [ ] **Step 7: Run route tests**

Run: `node --test public-harness/tests/routes.test.mjs` from the project root.

Expected: 11 tests pass. Fix the quota fixture so it imports `hashIp` once and compares no key or raw IP values.

- [ ] **Step 8: Start the harness and check the health endpoint**

Run: `node public-harness/server.mjs 4174` from the project root in a background terminal.

Then run:

```bash
curl -s -H "x-qoder-client-ip: 203.0.113.9" http://127.0.0.1:4174/functions/v1/app/api/health
```

Expected: `mode` is `public`, `capabilities.delete` is `false`, `quota.documents_limit` is `500`, and no key or IP value appears. Stop the harness after the check unless the next task needs it.

---

### Task 9: Add the public frontend mode and visitor-facing restrictions

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/lib/uploadBatch.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/AppShell.tsx`
- Modify: `frontend/src/pages/DocumentsPage.tsx`
- Modify: `frontend/src/pages/AskPage.tsx`
- Modify: `frontend/src/styles.css`
- Create: `frontend/src/lib/api.test.ts`
- Create: `frontend/src/App.test.tsx`
- Modify: `frontend/src/pages/DocumentsPage.test.tsx`
- Modify: `frontend/src/lib/uploadBatch.test.ts`

**Interfaces:**
- Consumes: `Health.mode`, `Health.capabilities`, `Health.quota`, `Health.upload_blocked_reason`; `VITE_API_ROOT`.
- Produces: build-time API root selection, `ApiError.code`, terminal batch stopping, hidden management navigation, public privacy/quota UI.

- [ ] **Step 1: Write failing API-root and terminal-stop tests**

Create `frontend/src/lib/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, getHealth } from './api';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('API root', () => {
  it('uses /api by default', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok', mode: 'local',
      capabilities: { upload: true, delete: true, manage_connections: true },
      upload_blocked_reason: null, trusted_ip: true,
      siliconflow_configured: false, deepseek_configured: false,
      models: { embeddings: 'e', chat: 'c' }, document_count: 0,
      quota: {
        scope: 'local', documents_used: 0, documents_limit: null,
        chunks_used: 0, chunks_limit: null, daily_uploads_used: null,
        daily_upload_limit: null, daily_uploads_remaining: null,
      },
    }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await getHealth();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/health');
  });

  it('uses the public Function root when VITE_API_ROOT is set', async () => {
    vi.stubEnv('VITE_API_ROOT', '/functions/v1/app/api');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: 'ok', mode: 'public',
      capabilities: { upload: false, delete: false, manage_connections: false },
      upload_blocked_reason: '无法确认客户端 IP，暂时不能上传。',
      trusted_ip: false, siliconflow_configured: true, deepseek_configured: true,
      models: { embeddings: 'e', chat: 'c' }, document_count: 0,
      quota: {
        scope: 'shared', documents_used: 0, documents_limit: 500,
        chunks_used: 0, chunks_limit: 5000, daily_uploads_used: 0,
        daily_upload_limit: 30, daily_uploads_remaining: 30,
      },
    }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await getHealth();
    expect(fetchMock.mock.calls[0][0]).toBe('/functions/v1/app/api/health');
  });

  it('keeps the error code from a quota response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      detail: '今日共享上传额度已用完，请明天再试。',
      code: 'daily_limit',
    }), { status: 429, headers: { 'content-type': 'application/json' } })));

    await expect(getHealth()).rejects.toMatchObject({
      status: 429,
      code: 'daily_limit',
    } satisfies Partial<ApiError>);
  });
});
```

Append to `frontend/src/lib/uploadBatch.test.ts`:

```ts
  it('stops at a terminal quota error and leaves later files unsent', async () => {
    const calls: string[] = [];
    const results = await uploadBatch(candidates, () => {}, async (file) => {
      calls.push(file.name);
      if (file.name === 'a.txt') {
        throw new ApiError('今日共享上传额度已用完。', 429, 'daily_limit');
      }
      return document(file.name);
    }, 'batch-test');

    expect(calls).toEqual(['a.txt']);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: 'folder/a.txt', status: 'failed', terminal: true,
    });
  });
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- src/lib/api.test.ts src/lib/uploadBatch.test.ts` from `frontend/`.

Expected: FAIL because `getHealth` still calls `/api/health` under the public root, `ApiError` has no `code`, and batches continue after 429.

- [ ] **Step 3: Implement API root, error code and terminal stopping**

In `frontend/src/lib/api.ts`, replace the constants and `ApiError`:

```ts
function apiRoot(): string {
  const configured = import.meta.env.VITE_API_ROOT as string | undefined;
  return configured ? configured.replace(/\/$/, '') : '/api';
}

function offlineMessage(): string {
  return import.meta.env.VITE_API_ROOT
    ? '无法连接共享资料库，请稍后重试。'
    : '无法连接本地服务。请确认后端已在 127.0.0.1:8000 启动。';
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
```

Update `errorMessage` to also read `code`:

```ts
function errorCode(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object' && 'code' in payload) {
    const code = (payload as { code: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return undefined;
}
```

Update `parseError`:

```ts
async function parseError(response: Response): Promise<ApiError> {
  const fallback = `请求失败（${response.status}）`;
  try {
    const payload: unknown = await response.json();
    return new ApiError(
      errorMessage(payload, fallback),
      response.status,
      errorCode(payload),
    );
  } catch {
    return new ApiError(fallback, response.status);
  }
}
```

Update `request` and the XHR call:

```ts
    response = await fetch(`${apiRoot()}${path}`, init);
```

```ts
    throw new ApiError(offlineMessage());
```

```ts
      reject(new ApiError(
        errorMessage(xhr.response as unknown, fallback),
        xhr.status,
        errorCode(xhr.response),
      ));
```

```ts
    xhr.open('POST', `${apiRoot()}/documents`);
```

Update `frontend/src/lib/uploadBatch.ts`:

```ts
export type BatchItemResult =
  | { path: string; status: 'success'; document: DocumentRecord }
  | { path: string; status: 'duplicate'; reason: string }
  | { path: string; status: 'failed'; reason: string; terminal?: true };

export function isTerminalUploadError(error: unknown): boolean {
  return error instanceof ApiError
    && (error.status === 429 || error.code === 'batch_limit');
}

export async function uploadBatch(
  files: UploadCandidate[],
  onProgress: (progress: BatchProgress) => void,
  uploadOne: UploadOne = uploadDocument,
  batchId: string = crypto.randomUUID(),
  shouldStop: (error: unknown) => boolean = isTerminalUploadError,
): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = [];
  for (const [offset, item] of files.entries()) {
    const index = offset + 1;
    const report = (progress: number) => onProgress({
      index, total: files.length, path: item.path, progress,
    });
    report(0);
    try {
      const document = await uploadOne(item.file, report, batchId);
      results.push({ path: item.path, status: 'success', document });
    } catch (error) {
      const reason = error instanceof Error ? error.message : '上传未完成，请稍后重试。';
      const terminal = shouldStop(error);
      results.push({
        path: item.path,
        status: error instanceof ApiError && error.status === 409 ? 'duplicate' : 'failed',
        reason,
        ...(terminal ? { terminal: true as const } : {}),
      });
      if (terminal) break;
    }
  }
  return results;
}
```

- [ ] **Step 4: Run the focused tests**

Run: `npm test -- src/lib/api.test.ts src/lib/uploadBatch.test.ts` from `frontend/`.

Expected: all tests pass.

- [ ] **Step 5: Write failing public UI tests**

Append to `frontend/src/pages/DocumentsPage.test.tsx` a public health helper and test:

```tsx
function publicHealthResponse(): Response {
  return response({
    status: 'ok', mode: 'public',
    capabilities: { upload: true, delete: false, manage_connections: false },
    upload_blocked_reason: null, trusted_ip: true,
    siliconflow_configured: true, deepseek_configured: true,
    models: { embeddings: 'test', chat: 'test' }, document_count: 1,
    quota: {
      scope: 'shared', documents_used: 1, documents_limit: 500,
      chunks_used: 3, chunks_limit: 5000, daily_uploads_used: 2,
      daily_upload_limit: 30, daily_uploads_remaining: 28,
    },
  });
}

it('shows shared quota, hides deletion and stops at a terminal quota error', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/health') return publicHealthResponse();
    return response({
      documents: [{
        id: 'shared-1', name: 'shared.txt', sha256: 'sha-1', size: 12,
        chunk_count: 1, created_at: '2026-10-30T00:00:00Z',
      }],
    });
  }));
  vi.mocked(uploadDocument).mockImplementation(async (file) => {
    if (file.name === 'a.txt') {
      throw new ApiError('今日共享上传额度已用完，请明天再试。', 429, 'daily_limit');
    }
    return {
      id: file.name, name: file.name, sha256: file.name, size: file.size,
      chunk_count: 1, created_at: '2026-10-30T00:00:00Z',
    };
  });

  render(<WorkspaceProvider><DocumentsPage /></WorkspaceProvider>);

  expect(await screen.findByText(/请勿上传隐私或机密资料/)).toBeTruthy();
  expect(screen.getByText(/共享库 1\/500/)).toBeTruthy();
  expect(screen.getByText(/今日剩余 28\/30/)).toBeTruthy();
  expect(screen.queryByLabelText('删除 shared.txt')).toBeNull();

  fireEvent.change(await screen.findByLabelText('选择文件'), {
    target: { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] },
  });

  await screen.findByText('未处理 1');
  expect(uploadDocument).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/今日共享上传额度已用完/)).toBeTruthy();
});
```

Import `ApiError` in the test:

```tsx
import { ApiError, deleteDocument, uploadDocument } from '../lib/api';
```

Create `frontend/src/App.test.tsx`:

```tsx
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { WorkspaceProvider } from './context/WorkspaceContext';

const publicHealth = {
  status: 'ok', mode: 'public',
  capabilities: { upload: true, delete: false, manage_connections: false },
  upload_blocked_reason: null, trusted_ip: true,
  siliconflow_configured: true, deepseek_configured: true,
  models: { embeddings: 'test', chat: 'test' }, document_count: 0,
  quota: {
    scope: 'shared', documents_used: 0, documents_limit: 500,
    chunks_used: 0, chunks_limit: 5000, daily_uploads_used: 0,
    daily_upload_limit: 30, daily_uploads_remaining: 30,
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('public routing', () => {
  it('hides connections and redirects the management route to ask', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/health') {
        return new Response(JSON.stringify(publicHealth), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ documents: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }));

    render(
      <MemoryRouter initialEntries={['/connections']}>
        <WorkspaceProvider><App /></WorkspaceProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('从资料里，找到确切答案。')).toBeTruthy();
    expect(screen.queryByText('模型连接')).toBeNull();
    expect(screen.getByText('共享资料库已连接')).toBeTruthy();
  });
});
```

- [ ] **Step 6: Run the UI tests and verify RED**

Run: `npm test -- src/pages/DocumentsPage.test.tsx src/App.test.tsx` from `frontend/`.

Expected: FAIL because the public UI does not yet show the notice, quota, hidden delete action or route guard.

- [ ] **Step 7: Implement the public UI**

In `frontend/src/App.tsx`:

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { useWorkspace } from './context/WorkspaceContext';
import { AskPage } from './pages/AskPage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { DocumentsPage } from './pages/DocumentsPage';

function ConnectionsRoute() {
  const { health } = useWorkspace();
  if (health && !health.capabilities.manage_connections) {
    return <Navigate to="/ask" replace />;
  }
  return <ConnectionsPage />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<Navigate to="/ask" replace />} />
        <Route path="ask" element={<AskPage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="connections" element={<ConnectionsRoute />} />
        <Route path="*" element={<Navigate to="/ask" replace />} />
      </Route>
    </Routes>
  );
}
```

In `frontend/src/components/AppShell.tsx`, replace the navigation map and status copy:

```tsx
  const canManageConnections = health?.capabilities.manage_connections ?? true;
  const items = navigation.filter(
    (item) => item.to !== '/connections' || canManageConnections,
  );
  const publicMode = health?.mode === 'public';
  const connected = Boolean(health);
  const statusLabel = connected
    ? publicMode ? '共享资料库已连接' : '本地服务已连接'
    : healthLoading ? '正在连接资料库' : '资料库未连接';
```

```tsx
          {items.map(({ to, label, icon: Icon }) => (
```

```tsx
          <span className="document-tally">
            {health?.document_count ?? documents.length} 份{publicMode ? '共享资料' : '本地资料'}
          </span>
```

In `frontend/src/pages/DocumentsPage.tsx`, add `health` to the workspace destructuring and define:

```tsx
  const publicMode = health?.mode === 'public';
  const uploadBlocked = publicMode && health
    ? !health.capabilities.upload || Boolean(health.upload_blocked_reason)
    : false;
```

At the top of `startUpload`:

```tsx
    if (uploadBlocked) {
      setUploadError(health?.upload_blocked_reason ?? '共享资料库暂时不能上传。');
      return;
    }
```

After `const results = await uploadBatch(...)`, replace the summary assignment:

```tsx
      const terminal = results.find(
        (item) => item.status === 'failed' && item.terminal,
      );
      const stopped = terminal
        ? prepared.files.slice(results.length).map((item) => ({
          path: item.path,
          reason: `${terminal.reason}（本批后续文件未处理）`,
        }))
        : [];
      setBatchSummary({
        results,
        skipped: prepared.skipped,
        unprocessed: [...prepared.unprocessed, ...stopped],
      });
```

Render the public notice after the page header:

```tsx
      {publicMode && health && (
        <div className="workspace-notice" role="note">
          <LockKeyhole size={18} strokeWidth={1.7} aria-hidden="true" />
          <div>
            <strong>共享资料库对所有访客可见</strong>
            <span>请勿上传隐私或机密资料。上传内容会用于共享检索并发送至模型服务。</span>
          </div>
        </div>
      )}
      {publicMode && health && (
        <div className="quota-strip" aria-label="共享资料库配额">
          <span>共享库 {health.quota.documents_used}/{health.quota.documents_limit}</span>
          <span>今日剩余 {health.quota.daily_uploads_remaining}/{health.quota.daily_upload_limit}</span>
          <span>分块 {health.quota.chunks_used}/{health.quota.chunks_limit}</span>
        </div>
      )}
      {publicMode && health?.upload_blocked_reason && (
        <div className="inline-alert warning" role="status">
          <span>{health.upload_blocked_reason}</span>
        </div>
      )}
```

Import `LockKeyhole` from `lucide-react`. Add `publicMode` copy to the page header:

```tsx
          <p className="eyebrow">{publicMode ? '共享知识来源' : '本地知识来源'}</p>
          <h1>资料库</h1>
          <p>
            {publicMode
              ? '所有访客共享的资料。每个人都可以上传和提问，但访客不能删除资料。'
              : '管理用于检索和回答的原始资料。上传后，内容会在本地切分并建立索引。'}
          </p>
```

Disable upload controls when blocked:

```tsx
          <button
            type="button"
            className="primary-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={Boolean(uploadState) || uploadBlocked}
            title={health?.upload_blocked_reason ?? undefined}
          >
```

```tsx
              <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()} disabled={Boolean(uploadState) || uploadBlocked}>选择文件</button>
              <button type="button" className="secondary-button" onClick={() => folderInputRef.current?.click()} disabled={Boolean(uploadState) || uploadBlocked}>
```

Conditionally hide the delete column and cell:

```tsx
              <thead><tr><th>文件名</th><th>大小</th><th>片段</th><th>上传时间</th>{!publicMode && <th><span className="sr-only">操作</span></th>}</tr></thead>
```

```tsx
                    {!publicMode && (
                      <td className="delete-cell">
                        <button type="button" className="icon-button danger-button" onClick={() => { setDeleteTarget(document); setDeleteError(null); }} aria-label={`删除 ${document.name}`} title="删除资料">
                          <Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                      </td>
                    )}
```

Render the delete dialog only when `!publicMode`:

```tsx
      {!publicMode && (
        <Dialog
          open={Boolean(deleteTarget)}
          onClose={() => { if (!deleting) setDeleteTarget(null); }}
          title="删除这份资料？"
          description={deleteTarget ? `“${deleteTarget.name}”及其全部索引片段将被永久删除，此操作无法撤销。` : undefined}
          variant="confirm"
        >
          {deleteError && <div className="inline-alert error" role="alert"><p>{deleteError}</p></div>}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={() => setDeleteTarget(null)} disabled={deleting}>取消</button>
            <button type="button" className="danger-solid-button" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting && <span className="spinner" aria-hidden="true" />}{deleting ? '正在删除' : '确认删除'}
            </button>
          </div>
        </Dialog>
      )}
```

Update the upload-zone copy:

```tsx
              <p>
                支持 TXT、MD、Markdown、PDF，单个文件不超过 20 MiB
                {publicMode ? '、500 个片段' : ''}
              </p>
```

In `frontend/src/pages/AskPage.tsx`, read health and use public copy:

```tsx
  const { documents, documentsLoading, documentsError, health } = useWorkspace();
  const publicMode = health?.mode === 'public';
```

```tsx
        <p className="eyebrow">{publicMode ? '共享资料 · 有据可查' : '本地资料 · 有据可查'}</p>
        <h1>从资料里，找到确切答案。</h1>
        <p>
          {publicMode
            ? 'FindAnswer 只依据共享资料库中的内容作答。每个结论都可以回到原文，没有依据时会明确说明；共享资料对所有访客可见。'
            : 'FindAnswer 只依据你提供的资料作答。每个结论都可以回到原文，没有依据时会明确说明。'}
        </p>
```

Add a persistent note below the intro for public mode:

```tsx
      {publicMode && (
        <div className="workspace-notice" role="note">
          <LockKeyhole size={18} strokeWidth={1.7} aria-hidden="true" />
          <div>
            <strong>共享资料库</strong>
            <span>请勿上传隐私或机密资料。问题和命中的资料片段会发送至模型服务。</span>
          </div>
          <Link to="/documents">查看资料库</Link>
        </div>
      )}
```

In `frontend/src/styles.css`, append:

```css
.quota-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-bottom: 16px;
  padding: 10px 14px;
  color: var(--muted);
  font-size: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.quota-strip span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

@media (max-width: 640px) {
  .quota-strip {
    gap: 6px 14px;
    padding: 9px 12px;
  }
}
```

- [ ] **Step 8: Run the frontend tests and build**

Run: `npm test` from `frontend/`.

Expected: all tests pass, including the new public UI, API-root and terminal-stop cases.

Run: `npm run build` from `frontend/`.

Expected: TypeScript build exits 0.

- [ ] **Step 9: Add the public build script**

Modify `frontend/package.json` scripts:

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "build:public": "tsc -b && vite build --mode public --outDir dist-public",
    "test": "vitest run --environment jsdom",
    "preview": "vite preview"
  },
```

Create `frontend/.env.public`:

```text
VITE_API_ROOT=/functions/v1/app/api
```

Run: `npm run build:public` from `frontend/`.

Expected: `frontend/dist-public/index.html` exists and its JavaScript contains `/functions/v1/app/api`; it does not contain `127.0.0.1`, Windows credential text or key-shaped strings.

---

### Task 10: Verify the complete public experience locally

**Files:**
- Modify: `frontend/vite.config.ts`
- Test: local harness and full regression suite

**Interfaces:**
- Consumes: `frontend/dist-public`, `public-harness/server.mjs`, all local tests.
- Produces: a repeatable local public preview and recorded evidence for every requested behavior.

- [ ] **Step 1: Add the local Function proxy for development**

Modify `frontend/vite.config.ts`:

```ts
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/functions/v1/app': {
        target: 'http://127.0.0.1:4174',
        changeOrigin: true,
      },
    },
  },
});
```

- [ ] **Step 2: Run the full automated suite**

Run each command from its directory:

```bash
cd backend && python -m pytest -v
```

```bash
cd frontend && npm test
```

```bash
cd frontend && npm run build
```

```bash
cd frontend && npm run build:public
```

```bash
node --test public-harness/tests
```

```bash
powershell -NoProfile -Command "Invoke-Pester scripts/tests/StartFindAnswer.Tests.ps1"
```

Expected: backend tests pass, frontend tests pass, both builds exit 0, all Node Function tests pass, and the launcher Pester suite passes. If Pester is unavailable, record the launcher check as not run; do not claim it passed.

- [ ] **Step 3: Start the local public preview**

Run in a background terminal:

```bash
node public-harness/server.mjs 4174
```

Wait for `http://127.0.0.1:4174` to respond, then open it in the browser.

Expected: the public interface loads with an empty shared library, "共享资料库" copy, a privacy notice, quota `0/500` and `今日剩余 30/30`, no delete controls and no "模型连接" navigation.

- [ ] **Step 4: Exercise upload, duplicate, retrieval, answer and refusal**

In the browser:

1. Create two harmless local files, `fixture-a.txt` with `FindAnswer 共享资料测试：项目代号是银杏。` and `fixture-b.md` with `公开版支持文件夹批量上传。`.
2. Upload both through the file picker.
3. Confirm the batch summary shows `成功 2`.
4. Upload `fixture-a.txt` again and confirm `重复 1` with the duplicate reason.
5. Ask `项目代号是什么？` and confirm the answer includes a citation `[1]`, the source card shows `fixture-a.txt`, and clicking the citation scrolls to the stored chunk.
6. Ask `这份资料里有没有提到火星殖民？` and confirm the refusal `你提供的资料中没有这个问题的答案。` with no citation.
7. Open the document chunks dialog and confirm both stored chunks are readable.
8. Confirm no delete button exists, the connections route redirects to `/ask`, and the browser console has no errors.

The harness uses fake embeddings and a fake chat response; label this run as local fixture behavior, not proof of SiliconFlow or DeepSeek connectivity.

- [ ] **Step 5: Check browser storage and console**

In the browser developer tools:

```js
Object.keys(localStorage)
Object.keys(sessionStorage)
```

Expected: neither contains keys, questions, file contents or auth data. Check the Console and Network panels: no key-shaped strings, no raw IP, no stack traces.

- [ ] **Step 6: Stop the harness**

Stop the background Node process. Do not leave it running for the hosted deployment.

---

### Task 11: Deploy to Qoder Sites behind explicit authorization gates

**Files:**
- Build output: `frontend/dist-public`
- Function package: `functions` (excluding `_qoder`, tests and harness)
- Schema source: `deploy/schema.sql`

**Interfaces:**
- Consumes: Qoder Sites MCP tools `get_context`, `prepare_site`, `get_site`, `ensure_backend`, `get_database_schema`, `create_database_migration`, `apply_database_migration`, `get_operation`, `publish_site`, `get_publish_status`, `get_function_logs`.
- Produces: a verified public Site URL or a precise blocker report.

- [ ] **Step 1: Preflight the package**

Run from the project root:

```bash
test -f frontend/dist-public/index.html
test -f functions/index.ts
test ! -e functions/_qoder
test ! -e functions/tests
test ! -e functions/vendor/unpdf/package-lock.json
find functions -type f | wc -l
du -sh functions frontend/dist-public
rg -n "sk-[A-Za-z0-9]" functions frontend/dist-public --glob '!functions/vendor/**' || true
rg -n "SILICONFLOW_API_KEY|DEEPSEEK_API_KEY" frontend/dist-public || true
```

Expected: no key-shaped values in source or build, no `_qoder`, no tests in the Function directory, Function content well below 50 MiB, and the public build contains no server key names. If any check fails, fix it before any cloud call.

- [ ] **Step 2: Stop for cloud authorization**

Before creating anything, state exactly what will be created: one Qoder Site, its Function, Database schema, Storage allocation and two Secret names. Ask for explicit confirmation. Do not treat the earlier approval of the public design as authorization to create cloud resources.

If the user declines, stop here. The local harness and all automated checks remain the delivered result; report publication as not performed.

- [ ] **Step 3: Check Deno availability and type-checking**

Run: `deno --version`.

Expected: a Deno 2.x version. If Deno is absent, stop and ask for explicit permission to install it. Do not install it silently. If permission is declined, record `deno check` as not run and rely on the Node tests plus manual review of the 30-line `index.ts`; do not claim Deno type-checking passed.

With Deno available, run:

```bash
deno check --node-modules-dir=none functions/index.ts
```

Expected: exit 0. The `_qoder` imports are deployment-injected; if Deno cannot resolve them locally, create no stub inside `functions`. Run the check only after confirming the platform's injected module declarations are available, or record the unresolved-module limitation precisely.

- [ ] **Step 4: Create the bootstrap Site**

Use the Sites MCP tools. Read `get_context` first and confirm the local project root. Then call `prepare_site` with:

```js
{
  actionId: '<new UUID for this action>',
  createNewSite: true,
  projectRoot: 'C:\\Users\\29433\\Documents\\Qoder\\2026-10-30\\4d8f706e',
  webDirectory: 'frontend/dist-public',
  displayName: 'FindAnswer',
  slug: 'findanswer',
  spa: true,
}
```

Expected: a ready draft with Project and Site IDs and a host. Leave it unpublished and do not show its publication confirmation. Retain the action ID and IDs for recovery.

- [ ] **Step 5: Allocate the function backend and storage**

Run `get_site` with `include: ['backend']`. Then call `ensure_backend` with the authorized capabilities:

```js
{
  siteId: '<site ID from the bootstrap draft>',
  capabilities: ['database', 'functions', 'storage'],
  databaseAccessModel: 'function_backend',
}
```

Wait for the Operation with `get_operation`; do not poll a terminal result. Then read `get_database_schema`.

Expected: a `function_backend` allocation with database, Functions and Storage ready. If Storage is unavailable, stop before the schema because public uploads require it; do not substitute Function-local files.

- [ ] **Step 6: Apply the reviewed schema**

Call `create_database_migration` with the exact contents of `deploy/schema.sql`, `accessPolicies: []`, a new request ID, a new client migration ID, the verified `schemaRef`, and display name `Create FindAnswer shared library`. Inspect the returned normalized SQL and policies. Once the plan matches `deploy/schema.sql`, call `apply_database_migration` with its exact `planRef` and `confirm: true`.

Wait for completion, then read `get_database_schema` again and verify:

- `documents`, `chunks`, `upload_reservations`, `upload_batch_attempts` exist;
- `documents.sha256` is unique;
- `upload_reservations.ip_slot_key` and `global_slot` are unique;
- `chunks_document_idx`, `reservations_ip_idx`, `reservations_batch_idx`, `attempts_batch_idx` exist;
- no access policy grants browser access.

If the migration is rejected, read `validation_reason`. Correct only the unsupported construct; do not change the access model or add `accessPolicies` entries.

- [ ] **Step 7: Prepare the complete Site**

Build the public frontend again after any source change:

```bash
cd frontend && npm run build:public
```

Then call `prepare_site` with a new action ID and:

```js
{
  actionId: '<new UUID for the complete action>',
  projectRoot: 'C:\\Users\\29433\\Documents\\Qoder\\2026-10-30\\4d8f706e',
  webDirectory: 'frontend/dist-public',
  functionDirectory: 'functions',
  projectId: '<bootstrap Site project ID>',
  databaseAccess: 'read_write',
  schemaRef: '<schemaRef from the verified read>',
  secretNames: ['SILICONFLOW_API_KEY', 'DEEPSEEK_API_KEY'],
  spa: true,
}
```

Expected: a ready draft with no blocker except missing Secret values. Do not publish yet.

- [ ] **Step 8: Configure Secrets through Site Settings**

Ask the user to open the Site Settings for this Site and enter `SILICONFLOW_API_KEY` and `DEEPSEEK_API_KEY`. Keys must be pasted only into that server-side settings form; never ask for them in chat, never put them in a command, file or test, and never read them back.

After the user confirms, wait for Secret synchronization to report ready. If synchronization is pending, wait and recheck the same action; do not republish under a new action.

- [ ] **Step 9: Publish and verify the live Site**

Call `publish_site` for the exact complete action. Read `get_publish_status` until the publish Operation commits. Report the returned `site.url`; do not promise a predicted address.

Then run these live checks:

1. Open the URL in a fresh browser context. Confirm the privacy notice, `共享库 0/500`, `今日剩余 30/30`, no delete controls and no connections navigation.
2. Upload one harmless test file through the real form and confirm it appears for a second visitor in a separate browser context.
3. Ask a question answerable from that file; confirm a real citation maps to the uploaded file and chunk.
4. Ask an unrelated question; confirm the exact refusal and no citation.
5. From the same origin console, call `fetch('/functions/v1/app/api/documents/<id>', {method:'DELETE'})` and confirm 403; call the connections endpoint with a fake body and confirm 403.
6. Confirm the browser's local/session storage contains no key or question data.
7. Read `get_function_logs` for the deployment window. Confirm no key values, raw IPs, signed URLs or raw provider errors. Do not print secret values.

If the test file must be removed after acceptance, do not use the public UI. Ask for explicit authorization before deleting it through Sites management tools, and report that removal separately.

- [ ] **Step 10: Record unverified items honestly**

The final report must distinguish:

- local fixture acceptance (harness) from real SiliconFlow/DeepSeek calls;
- local quota tests from live quota behavior;
- health/permission checks from full runtime acceptance;
- Deno type-checking, if it could not run;
- trusted-IP header verification, if the platform did not inject one of the allowlisted headers (uploads stay disabled, Q&A still works);
- browser layouts actually inspected.

Do not claim the published integration works for a path that was not exercised.

---

## Self-Review Checklist

- [ ] Every spec section is covered: shared library, no visitor deletion or key access, Qoder Sites frontend/functions/storage/database/secrets, server-side format/quota/permissions, trusted IP, 100/30/500 limits, duplicate 409, reservations, stale recovery, retrieval threshold, no DeepSeek without evidence, strict citations, no history, sanitized errors, local regression, pre-publish and post-publish checks.
- [ ] No placeholder remains; every task lists exact files, interfaces, tests and commands.
- [ ] Interfaces agree: `Health.quota` fields match the local and public payloads; `uploadBatch` terminal flag matches the page's unprocessed calculation; repository method names match quota, ingestion and service calls; route paths match the frontend `VITE_API_ROOT`.
- [ ] No task silently adds a cloud side effect. Tasks 1-10 are local only; Task 11 stops at each authorization gate.
- [ ] No test uses a real API key. All fake keys are clearly fake and never printed.
- [ ] The formal shared library is never used for destructive quota tests.
