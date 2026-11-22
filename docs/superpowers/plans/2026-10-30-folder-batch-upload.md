# FindAnswer Folder Batch Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users select a folder or multiple files, filter supported documents, and upload them sequentially with per-file progress and a complete batch summary.

**Architecture:** The browser folder input supplies recursive files and relative paths. Pure frontend helpers own selection and sequential scheduling; the existing single-file endpoint remains the ingestion boundary and accepts an optional batch identifier for server-side batch counting.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, FastAPI, pytest.

**Spec:** `docs/superpowers/specs/2026-10-30-findanswer-design.md`

## Global Constraints

- Support only TXT, MD, Markdown and textual PDF; no OCR.
- Maximum file size is exactly 20 MiB; maximum eligible files per batch is 100.
- Sort candidates by browser-provided relative path and process only the first 100; label the rest unprocessed.
- Reuse the single-file upload API sequentially; one failed file does not stop the batch.
- Existing SHA-256 duplicate responses remain HTTP 409 and count as duplicate, not failure.
- Do not persist files, paths, keys or batch state in browser storage.
- Preserve the quiet gray-white workspace and existing local RAG behavior.
- The directory is not a Git repository: do not commit, merge or push.

---

### Task 1: Accept and enforce batch identifiers in the local API

**Files:**
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_api.py`

**Interfaces:**
- Consumes: existing `create_app()` and `POST /api/documents` multipart upload.
- Produces: optional multipart form field `batch_id: str | None`; one batch accepts at most 100 extension- and size-eligible requests.

- [ ] **Step 1: Write the failing API test**

Append a test that uses the existing `make_client(tmp_path)` helper. Repeating content avoids creating 100 distinct embeddings while still exercising duplicate counting.

```python
def test_batch_id_enforces_100_eligible_uploads(tmp_path):
    client, _ = make_client(tmp_path)
    responses = []
    for index in range(101):
        responses.append(client.post(
            "/api/documents",
            data={"batch_id": "batch-limit"},
            files={"file": (f"{index}.txt", b"same", "text/plain")},
        ))

    assert responses[0].status_code == 201
    assert all(response.status_code == 409 for response in responses[1:100])
    assert responses[100].status_code == 400
    assert responses[100].json() == {"detail": "每批最多上传 100 个合格文件。"}
```

- [ ] **Step 2: Run the test and verify RED**

Run: `python -m pytest tests/test_api.py::test_batch_id_enforces_100_eligible_uploads -v` from `backend/`.

Expected: the 101st response is 409 instead of the required 400.

- [ ] **Step 3: Implement minimal batch counting**

Import `Form` from FastAPI. Create `batch_counts: dict[str, int] = {}` inside `create_app()` so each app has isolated state. Change only the route signature:

```python
@app.post("/api/documents", status_code=201)
async def upload_document(
    file: UploadFile = File(...),
    batch_id: str | None = Form(None),
) -> dict:
```

Insert the following immediately after the existing oversize check and before SHA-256 calculation. There is no `await` between the completed file read and increment, so the event-loop operation is atomic.

```python
if batch_id is not None:
    if not 1 <= len(batch_id) <= 128:
        raise HTTPException(400, "批次标识无效。")
    count = batch_counts.get(batch_id, 0) + 1
    if count > 100:
        raise HTTPException(400, "每批最多上传 100 个合格文件。")
    batch_counts[batch_id] = count
```

- [ ] **Step 4: Run focused and existing API tests**

Run: `python -m pytest tests/test_api.py -v` from `backend/`.

Expected: all API tests pass, including uploads without `batch_id`.

---

### Task 2: Build deterministic folder/file selection

**Files:**
- Create: `frontend/src/lib/fileSelection.ts`
- Test: `frontend/src/lib/fileSelection.test.ts`

**Interfaces:**
- Consumes: browser `File` objects, including `webkitRelativePath` for folder selections.
- Produces: `UploadCandidate`, `SkippedFile`, `PreparedUpload`, and `prepareUpload(files: File[]): PreparedUpload`.

- [ ] **Step 1: Write failing selection tests**

```tsx
import { describe, expect, it } from 'vitest';
import { prepareUpload } from './fileSelection';

function file(name: string, path = '', size = 1): File {
  const value = new File(['x'], name);
  Object.defineProperty(value, 'size', { value: size });
  Object.defineProperty(value, 'webkitRelativePath', { value: path });
  return value;
}

describe('prepareUpload', () => {
  it('filters mixed files, keeps relative paths and sorts eligible files', () => {
    const result = prepareUpload([
      file('b.txt', 'folder/b.txt'),
      file('image.png', 'folder/image.png'),
      file('a.MD', 'folder/nested/a.MD'),
      file('large.pdf', 'folder/large.pdf', 20 * 1024 * 1024 + 1),
    ]);

    expect(result.files.map((item) => item.path)).toEqual([
      'folder/b.txt',
      'folder/nested/a.MD',
    ]);
    expect(result.skipped.map((item) => item.path)).toEqual([
      'folder/image.png',
      'folder/large.pdf',
    ]);
  });

  it('selects only the first 100 eligible files and labels the rest unprocessed', () => {
    const input = Array.from({ length: 101 }, (_, index) =>
      file(`${String(index).padStart(3, '0')}.txt`, `folder/${String(index).padStart(3, '0')}.txt`));
    const result = prepareUpload(input);

    expect(result.files).toHaveLength(100);
    expect(result.unprocessed).toHaveLength(1);
    expect(result.unprocessed[0]).toEqual({
      path: 'folder/100.txt',
      reason: '超过单批 100 个文件上限',
    });
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- src/lib/fileSelection.test.ts` from `frontend/`.

Expected: FAIL because `./fileSelection` does not exist.

- [ ] **Step 3: Implement the pure selector**

```ts
export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_BATCH_FILES = 100;

export interface UploadCandidate {
  file: File;
  path: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface PreparedUpload {
  files: UploadCandidate[];
  skipped: SkippedFile[];
  unprocessed: SkippedFile[];
}

export function prepareUpload(files: File[]): PreparedUpload {
  const skipped: SkippedFile[] = [];
  const eligible: UploadCandidate[] = [];
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (!/\.(txt|md|markdown|pdf)$/i.test(file.name)) {
      skipped.push({ path, reason: '不支持的文件格式' });
    } else if (file.size > MAX_FILE_SIZE) {
      skipped.push({ path, reason: '文件超过 20 MiB' });
    } else {
      eligible.push({ file, path });
    }
  }
  eligible.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    files: eligible.slice(0, MAX_BATCH_FILES),
    skipped,
    unprocessed: eligible.slice(MAX_BATCH_FILES).map(({ path }) => ({
      path,
      reason: '超过单批 100 个文件上限',
    })),
  };
}
```

- [ ] **Step 4: Run the selector tests**

Run: `npm test -- src/lib/fileSelection.test.ts` from `frontend/`.

Expected: 2 tests pass.

---

### Task 3: Add sequential batch scheduling and multipart batch IDs

**Files:**
- Modify: `frontend/src/lib/api.ts`
- Create: `frontend/src/lib/uploadBatch.ts`
- Test: `frontend/src/lib/uploadBatch.test.ts`

**Interfaces:**
- Consumes: `UploadCandidate` from `fileSelection.ts`; existing `ApiError` and `DocumentRecord`.
- Produces: `uploadDocument(file, onProgress, batchId?)`; `BatchProgress`, `BatchItemResult`, and `uploadBatch(files, onProgress, uploadOne?, batchId?)`.

- [ ] **Step 1: Write failing scheduler tests**

```tsx
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import type { DocumentRecord } from './types';
import type { UploadCandidate } from './fileSelection';
import { uploadBatch } from './uploadBatch';

const candidates: UploadCandidate[] = ['a.txt', 'b.txt', 'c.txt'].map((name) => ({
  file: new File([name], name),
  path: `folder/${name}`,
}));

function document(name: string): DocumentRecord {
  return {
    id: name, name, sha256: name, size: 1, chunk_count: 1,
    created_at: '2026-10-30T00:00:00Z',
  };
}

describe('uploadBatch', () => {
  it('runs sequentially, reports one-based progress and shares one batch ID', async () => {
    let active = 0;
    let maximumActive = 0;
    const calls: string[] = [];
    const progress: string[] = [];
    const results = await uploadBatch(candidates, (item) => {
      if (item.progress === 0) progress.push(`${item.index}/${item.total}:${item.path}`);
    }, async (file, onProgress, batchId) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push(`${file.name}:${batchId}`);
      onProgress(50);
      await Promise.resolve();
      active -= 1;
      return document(file.name);
    }, 'batch-test');

    expect(maximumActive).toBe(1);
    expect(calls).toEqual(['a.txt:batch-test', 'b.txt:batch-test', 'c.txt:batch-test']);
    expect(progress).toEqual(['1/3:folder/a.txt', '2/3:folder/b.txt', '3/3:folder/c.txt']);
    expect(results.every((item) => item.status === 'success')).toBe(true);
  });

  it('classifies duplicates and continues after failure', async () => {
    const results = await uploadBatch(candidates, () => {}, async (file) => {
      if (file.name === 'a.txt') throw new ApiError('重复', 409);
      if (file.name === 'b.txt') throw new ApiError('索引失败', 502);
      return document(file.name);
    }, 'batch-test');

    expect(results.map((item) => item.status)).toEqual(['duplicate', 'failed', 'success']);
    expect(results[1]).toEqual({ path: 'folder/b.txt', status: 'failed', reason: '索引失败' });
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- src/lib/uploadBatch.test.ts` from `frontend/`.

Expected: FAIL because `./uploadBatch` does not exist.

- [ ] **Step 3: Extend the existing upload API**

Change the existing function signature without changing its XHR implementation:

```ts
export function uploadDocument(
  file: File,
  onProgress: (percentage: number) => void,
  batchId?: string,
): Promise<DocumentRecord>
```

Insert this statement immediately after `data.append('file', file)`:

```ts
if (batchId) data.append('batch_id', batchId);
```

- [ ] **Step 4: Implement the scheduler**

```ts
import { ApiError, uploadDocument } from './api';
import type { UploadCandidate } from './fileSelection';
import type { DocumentRecord } from './types';

export interface BatchProgress {
  index: number;
  total: number;
  path: string;
  progress: number;
}

export type BatchItemResult =
  | { path: string; status: 'success'; document: DocumentRecord }
  | { path: string; status: 'duplicate'; reason: string }
  | { path: string; status: 'failed'; reason: string };

export type UploadOne = (
  file: File,
  onProgress: (percentage: number) => void,
  batchId?: string,
) => Promise<DocumentRecord>;

export async function uploadBatch(
  files: UploadCandidate[],
  onProgress: (progress: BatchProgress) => void,
  uploadOne: UploadOne = uploadDocument,
  batchId: string = crypto.randomUUID(),
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
      results.push({
        path: item.path,
        status: error instanceof ApiError && error.status === 409 ? 'duplicate' : 'failed',
        reason,
      });
    }
  }
  return results;
}
```

- [ ] **Step 5: Run scheduler and existing frontend tests**

Run: `npm test` from `frontend/`.

Expected: all frontend tests pass.

---

### Task 4: Wire folder selection, progress and summaries into DocumentsPage

**Files:**
- Modify: `frontend/src/pages/DocumentsPage.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/src/pages/DocumentsPage.test.tsx`

**Interfaces:**
- Consumes: `prepareUpload()`, `uploadBatch()`, `BatchProgress`, `BatchItemResult`, and `SkippedFile`.
- Produces: file and folder inputs, sequential progress, and summaries with success/duplicate/skipped/unprocessed/failed counts plus per-file reasons.

- [ ] **Step 1: Write the failing page interaction test**

Mock only the upload boundary; use the real `WorkspaceProvider` and page. Stub `fetch` for `/api/health` and `/api/documents` using the same health fixture shape as `ConnectionsPage.test.tsx`.

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '../context/WorkspaceContext';
import { uploadDocument } from '../lib/api';
import { DocumentsPage } from './DocumentsPage';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return { ...actual, uploadDocument: vi.fn() };
});

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

describe('DocumentsPage folder upload', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('uploads eligible folder files and summarizes skipped files', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/health') return response({
        status: 'ok', siliconflow_configured: true, deepseek_configured: true,
        models: { embeddings: 'test', chat: 'test' }, document_count: 0,
      });
      return response({ documents: [] });
    }));
    vi.mocked(uploadDocument).mockImplementation(async (file) => ({
      id: file.name, name: file.name, sha256: file.name, size: file.size,
      chunk_count: 1, created_at: '2026-10-30T00:00:00Z',
    }));
    render(<WorkspaceProvider><DocumentsPage /></WorkspaceProvider>);
    const text = new File(['text'], 'note.txt');
    Object.defineProperty(text, 'webkitRelativePath', { value: 'folder/note.txt' });
    const image = new File(['image'], 'image.png');
    Object.defineProperty(image, 'webkitRelativePath', { value: 'folder/image.png' });

    fireEvent.change(await screen.findByLabelText('选择文件夹'), {
      target: { files: [text, image] },
    });

    await screen.findByText('成功 1');
    await screen.findByText('跳过 1');
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    expect(screen.getByText('folder/image.png')).toBeTruthy();
    expect(vi.mocked(uploadDocument).mock.calls[0][2]).toEqual(expect.any(String));
  });
});
```

- [ ] **Step 2: Run the page test and verify RED**

Run: `npm test -- src/pages/DocumentsPage.test.tsx` from `frontend/`.

Expected: FAIL because no accessible folder input or batch summary exists.

- [ ] **Step 3: Replace single-file orchestration with the helpers**

Add `fileInputRef` and `folderInputRef`. Both inputs call one `startUpload(files: File[])`; the drop handler passes all dropped files. Set the nonstandard directory attributes from a mounted-effect ref instead of a JSX type assertion:

```tsx
useEffect(() => {
  const folderInput = folderInputRef.current;
  if (!folderInput) return;
  folderInput.setAttribute('webkitdirectory', '');
  folderInput.setAttribute('directory', '');
}, []);

const startUpload = async (input: File[]) => {
  if (uploadState || input.length === 0) return;
  const prepared = prepareUpload(input);
  setBatchSummary(null);
  setUploadError(null);
  if (prepared.files.length === 0) {
    setBatchSummary({ results: [], skipped: prepared.skipped, unprocessed: prepared.unprocessed });
    return;
  }
  setUploadState({ index: 1, total: prepared.files.length, name: prepared.files[0].path, progress: 0 });
  try {
    const results = await uploadBatch(prepared.files, (current) => {
      setUploadState({
        index: current.index, total: current.total,
        name: current.path, progress: current.progress,
      });
    });
    setBatchSummary({ results, skipped: prepared.skipped, unprocessed: prepared.unprocessed });
  } catch (error) {
    setUploadError(error instanceof Error ? error.message : '批量上传未完成，请稍后重试。');
  } finally {
    setUploadState(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
  }
  await Promise.all([refreshDocuments(), refreshHealth()]).catch(() => {});
};
```

Replace the existing single-upload state with this exact shape and define batch summary state with this exact shape:

```ts
const [uploadState, setUploadState] = useState<{
  index: number;
  total: number;
  name: string;
  progress: number;
} | null>(null);
const [batchSummary, setBatchSummary] = useState<{
  results: BatchItemResult[];
  skipped: SkippedFile[];
  unprocessed: SkippedFile[];
} | null>(null);
```

- [ ] **Step 4: Add accessible controls, progress and result details**

Import `FolderOpen` from `lucide-react`. Add both inputs and keep them disabled from activation while `uploadState` is non-null:

```tsx
<input
  ref={fileInputRef}
  aria-label="选择文件"
  className="sr-only"
  type="file"
  accept={ACCEPTED_FILES}
  multiple
  onChange={(event) => void startUpload(Array.from(event.target.files ?? []))}
/>
<input
  ref={folderInputRef}
  aria-label="选择文件夹"
  className="sr-only"
  type="file"
  accept={ACCEPTED_FILES}
  multiple
  onChange={(event) => void startUpload(Array.from(event.target.files ?? []))}
/>
<button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()}>选择文件</button>
<button type="button" className="secondary-button" onClick={() => folderInputRef.current?.click()} disabled={Boolean(uploadState)}>
  <FolderOpen size={16} aria-hidden="true" />选择文件夹
</button>
```

Render the existing progress bar with this additional one-based position line:

```tsx
<span className="batch-position">当前第 {uploadState.index} 个／共 {uploadState.total} 个</span>
```

Before `return`, derive stable counts and non-success detail rows:

```tsx
const successCount = batchSummary?.results.filter((item) => item.status === 'success').length ?? 0;
const duplicateCount = batchSummary?.results.filter((item) => item.status === 'duplicate').length ?? 0;
const failedCount = batchSummary?.results.filter((item) => item.status === 'failed').length ?? 0;
const detailRows = batchSummary ? [
  ...batchSummary.skipped.map((item) => ({ ...item, status: '跳过' })),
  ...batchSummary.unprocessed.map((item) => ({ ...item, status: '未处理' })),
  ...batchSummary.results.flatMap((item) => item.status === 'success' ? [] : [{
    path: item.path,
    reason: item.reason,
    status: item.status === 'duplicate' ? '重复' : '失败',
  }]),
] : [];
```

Render this summary after the existing upload alerts:

```tsx
{batchSummary && (
  <section className="batch-summary" aria-label="批量上传结果">
    <div className="batch-counts">
      <span>成功 {successCount}</span><span>重复 {duplicateCount}</span>
      <span>跳过 {batchSummary.skipped.length}</span>
      <span>未处理 {batchSummary.unprocessed.length}</span><span>失败 {failedCount}</span>
    </div>
    {detailRows.length > 0 && (
      <details className="batch-details">
        <summary>查看批次明细（{detailRows.length}）</summary>
        <ul>{detailRows.map((item, index) => (
          <li key={`${item.path}-${index}`}><strong>{item.status}</strong><span>{item.path}</span><p>{item.reason}</p></li>
        ))}</ul>
      </details>
    )}
  </section>
)}
```

- [ ] **Step 5: Extend existing gray-white styles**

Append these focused styles and use them from the markup above; do not add gradients, glow effects or a new theme.

```css
.batch-summary {
  margin-top: 16px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}
.batch-counts { display: flex; flex-wrap: wrap; gap: 8px 20px; font-weight: 600; }
.batch-position { display: block; color: var(--muted); font-size: 13px; }
.batch-details { margin-top: 12px; color: var(--muted); }
.batch-details summary { cursor: pointer; color: var(--text); }
.batch-details ul { margin: 12px 0 0; padding: 0; list-style: none; }
.batch-details li { padding: 10px 0; border-top: 1px solid var(--border); overflow-wrap: anywhere; }
.batch-details li strong { display: inline-block; min-width: 52px; color: var(--text); }
.batch-details li p { margin-top: 2px; font-size: 13px; }
@media (max-width: 640px) {
  .batch-counts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
```

- [ ] **Step 6: Run all frontend tests and production build**

Run from `frontend/`:

```bash
npm test
npm run build
```

Expected: all tests pass; TypeScript and Vite build exit 0.

---

### Task 5: Full local regression and browser verification

**Files:**
- Verify only; fix regressions in the owning module with a failing test first.

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: verified local folder upload without regressions to RAG, credentials or startup.

- [ ] **Step 1: Run complete automated regression**

Run from `backend/`: `python -m pytest -v`.

Run from `frontend/`: `npm test` and `npm run build`.

Run from the project root:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\tests\StartFindAnswer.Tests.ps1"
```

Expected: every command exits 0; record exact test counts.

- [ ] **Step 2: Exercise the folder UI in a browser without paid API calls**

Use the production frontend build and a temporary verification harness stored only in the SDD workspace. The harness serves `frontend/dist` with SPA fallback and provides fake `/api/health`, `/api/documents`, and `/api/documents` upload responses on an ephemeral port; never call SiliconFlow or DeepSeek. Navigate to the temporary server, dispatch a synthetic `change` event on the hidden folder input with `File` objects whose `webkitRelativePath` represents `folder/nested/b.txt`, `folder/a.md`, `folder/image.png`, `folder/large.pdf` and one deliberately failing file. Verify deterministic sorting, `当前第 N 个／共 M 个`, current path, single-file progress, one final list refresh, summary details, narrow-width layout, no console errors and no local/session storage writes. Remove the temporary server and harness files after verification.

- [ ] **Step 3: Exercise duplicates and partial failure in the same harness**

Configure the fake upload endpoint so one file returns HTTP 409 and another returns HTTP 502 while later files succeed. Verify duplicate and failed counts are separate, reasons are listed, the batch continues after each failure, and successful documents still appear in the summary.

- [ ] **Step 4: Verify the 100-file boundary without paid API calls**

Run the existing automated boundary tests from `frontend/`:

```bash
npm test -- src/lib/fileSelection.test.ts src/lib/uploadBatch.test.ts
```

Expected: selection marks file 101 unprocessed and the scheduler never invokes more than 100 uploads. Do not initiate 101 real uploads in the browser because that would consume paid Embedding calls.

- [ ] **Step 5: Request independent code review**

Review the actual modified files against the approved spec. Fix Critical and Important findings with regression tests before reporting completion; do not claim success without fresh command output and browser evidence.
