import { CloudUpload, FileText, FolderOpen, LockKeyhole, LogOut, RefreshCw, Trash2, Upload, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Dialog } from '../components/Dialog';
import { useWorkspace } from '../context/WorkspaceContext';
import { deleteDocument, getDocumentChunks } from '../lib/api';
import { prepareUpload } from '../lib/fileSelection';
import type { SkippedFile } from '../lib/fileSelection';
import { uploadBatch } from '../lib/uploadBatch';
import type { BatchItemResult } from '../lib/uploadBatch';
import type { DocumentRecord, SourceChunk } from '../lib/types';

const ACCEPTED_FILES = '.txt,.md,.markdown,.pdf';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

export function DocumentsPage() {
  const {
    health,
    documents,
    documentsLoading,
    documentsError,
    refreshDocuments,
    refreshHealth,
    refreshAll,
    resetExperience,
  } = useWorkspace();
  const publicMode = health?.mode === 'public';
  const uploadBlocked = health
    ? !health.capabilities.upload || Boolean(health.upload_blocked_reason)
    : false;
  const [dragActive, setDragActive] = useState(false);
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
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<DocumentRecord | null>(null);
  const [chunks, setChunks] = useState<SourceChunk[]>([]);
  const [chunksLoading, setChunksLoading] = useState(false);
  const [chunksError, setChunksError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocumentRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [endOpen, setEndOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const chunksControllerRef = useRef<AbortController | null>(null);
  const chunksRequestRef = useRef(0);

  useEffect(() => () => {
    chunksRequestRef.current += 1;
    chunksControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    const folderInput = folderInputRef.current;
    if (!folderInput) return;
    folderInput.setAttribute('webkitdirectory', '');
    folderInput.setAttribute('directory', '');
  }, []);

  const startUpload = async (input: File[]) => {
    if (uploadState || input.length === 0) return;
    if (uploadBlocked) {
      setUploadError(health?.upload_blocked_reason ?? '临时资料库暂时不能上传。');
      return;
    }
    const prepared = prepareUpload(input);
    setBatchSummary(null);
    setUploadError(null);
    setSuccessMessage(null);
    if (prepared.files.length === 0) {
      setBatchSummary({ results: [], skipped: prepared.skipped, unprocessed: prepared.unprocessed });
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
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
      const terminal = results.find(
        (item): item is Extract<BatchItemResult, { status: 'failed' }> =>
          item.status === 'failed' && item.terminal === true,
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
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : '批量上传未完成，请稍后重试。');
    } finally {
      setUploadState(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
    await Promise.all([refreshDocuments(), refreshHealth()]).catch(() => {});
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (uploadState) return;
    void startUpload(Array.from(event.dataTransfer.files ?? []));
  };

  const openDocument = async (document: DocumentRecord) => {
    chunksControllerRef.current?.abort();
    const requestId = ++chunksRequestRef.current;
    const controller = new AbortController();
    chunksControllerRef.current = controller;
    setSelectedDocument(document);
    setChunks([]);
    setChunksError(null);
    setChunksLoading(true);
    try {
      const response = await getDocumentChunks(document.id, controller.signal);
      if (chunksRequestRef.current === requestId) setChunks(response.chunks);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (chunksRequestRef.current === requestId) {
        setChunksError(error instanceof Error ? error.message : '无法读取资料片段。');
      }
    } finally {
      if (chunksRequestRef.current === requestId) setChunksLoading(false);
    }
  };

  const closeDocument = () => {
    chunksRequestRef.current += 1;
    chunksControllerRef.current?.abort();
    setSelectedDocument(null);
    setChunksLoading(false);
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDocument(deleteTarget.id);
      const deletedName = deleteTarget.name;
      setDeleteTarget(null);
      setSuccessMessage(`“${deletedName}”已从资料库删除。`);
      await Promise.all([refreshDocuments(), refreshHealth()]);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除未完成，请稍后重试。');
    } finally {
      setDeleting(false);
    }
  };

  const confirmEndExperience = async () => {
    if (ending) return;
    setEnding(true);
    setEndError(null);
    try {
      await resetExperience();
      setEndOpen(false);
      closeDocument();
      setBatchSummary(null);
      setUploadError(null);
      setSuccessMessage('临时资料库已清空，可以重新开始。');
    } catch (error) {
      setEndError(error instanceof Error ? error.message : '清空未完成，请稍后重试。');
    } finally {
      setEnding(false);
    }
  };

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

  return (
    <main className="page documents-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">{publicMode ? '临时知识来源' : '本地知识来源'}</p>
          <h1>资料库</h1>
          <p>
            {publicMode
              ? '这是本次体验的临时资料库，默认从空库开始。你添加的资料只属于当前标签页，关闭页面或结束体验后会被清除。'
              : '管理用于检索和回答的原始资料。上传后，内容会在本地切分并建立索引。'}
          </p>
        </div>
        <div className="page-header-actions">
          <span className="document-count">共 {documents.length} 份资料</span>
          {publicMode && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => { setEndError(null); setEndOpen(true); }}
              disabled={Boolean(uploadState) || ending}
            >
              <LogOut size={16} aria-hidden="true" />结束体验并清空
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={Boolean(uploadState) || uploadBlocked}
            title={health?.upload_blocked_reason ?? undefined}
          >
            <Upload size={16} aria-hidden="true" />上传资料
          </button>
        </div>
      </header>

      {publicMode && health && (
        <div className="workspace-notice" role="note">
          <LockKeyhole size={18} strokeWidth={1.7} aria-hidden="true" />
          <div>
            <strong>临时资料库只属于当前标签页</strong>
            <span>资料仅用于本次体验的检索，关闭页面后会清除。请勿上传隐私或机密资料；上传内容会发送至模型服务。</span>
          </div>
        </div>
      )}
      {publicMode && health && (
        <div className="quota-strip" aria-label="临时资料库配额">
          <span>本次体验 {health.quota.documents_used}/{health.quota.documents_limit} 份</span>
          <span className="quota-divider" aria-hidden="true"> · </span>
          <span>片段 {health.quota.chunks_used}/{health.quota.chunks_limit}</span>
          <span className="quota-divider" aria-hidden="true"> · </span>
          <span>今日剩余 {health.quota.daily_uploads_remaining}/{health.quota.daily_upload_limit}</span>
        </div>
      )}
      {health?.upload_blocked_reason && (
        <div className="inline-alert warning" role="status">
          <span>{health.upload_blocked_reason}</span>
        </div>
      )}

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

      <section
        className={`upload-zone${dragActive ? ' drag-active' : ''}${uploadState ? ' uploading' : ''}`}
        aria-label="上传资料"
        onDragEnter={(event) => { event.preventDefault(); if (!uploadState) setDragActive(true); }}
        onDragOver={(event) => { event.preventDefault(); if (!uploadState) setDragActive(true); }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
        }}
        onDrop={handleDrop}
      >
        {uploadState ? (
          <div className="upload-progress" role="status" aria-live="polite">
            <div className="upload-icon"><span className="spinner dark" aria-hidden="true" /></div>
            <div className="upload-progress-copy">
              <strong>{uploadState.progress < 100 ? '正在上传资料' : '正在整理资料并建立索引'}</strong>
              <span title={uploadState.name}>{uploadState.name}</span>
              <span className="batch-position">当前第 {uploadState.index} 个／共 {uploadState.total} 个</span>
              <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={uploadState.progress} aria-label="文件上传进度">
                <span style={{ width: `${uploadState.progress}%` }} />
              </div>
            </div>
            <span className="progress-number">{uploadState.progress}%</span>
          </div>
        ) : (
          <>
            <div className="upload-icon"><CloudUpload size={23} strokeWidth={1.6} aria-hidden="true" /></div>
            <div>
              <strong>{dragActive ? '松开以上传文件' : '将文件拖到这里，或从设备中选择'}</strong>
              <p>
                {publicMode
                  ? '支持 TXT、MD、Markdown、PDF，单个文件不超过 20 MiB；本次体验最多 20 份资料、200 个片段。'
                  : '支持 TXT、MD、Markdown、PDF，单个文件不超过 20 MiB、500 个片段'}
              </p>
            </div>
            <div className="upload-zone-actions">
              <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()} disabled={Boolean(uploadState) || uploadBlocked}>选择文件</button>
              <button type="button" className="secondary-button" onClick={() => folderInputRef.current?.click()} disabled={Boolean(uploadState) || uploadBlocked}>
                <FolderOpen size={16} aria-hidden="true" />选择文件夹
              </button>
            </div>
          </>
        )}
      </section>

      {uploadError && <div className="inline-alert error" role="alert"><XCircle size={18} aria-hidden="true" /><p>{uploadError}</p></div>}
      {successMessage && <div className="inline-alert success" role="status"><FileText size={18} aria-hidden="true" /><p>{successMessage}</p></div>}

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

      <section className="documents-section" aria-labelledby="documents-list-title">
        <div className="section-heading">
          <div><h2 id="documents-list-title">全部资料</h2><span>选择文件名可查看切分后的原文片段</span></div>
          <button type="button" className="icon-button" onClick={() => void refreshAll()} disabled={documentsLoading} aria-label="刷新资料列表" title="刷新资料列表">
            <RefreshCw size={17} className={documentsLoading ? 'rotating' : ''} aria-hidden="true" />
          </button>
        </div>

        {documentsError ? (
          <div className="list-state error-state" role="alert">
            <XCircle size={23} strokeWidth={1.6} aria-hidden="true" />
            <strong>资料列表暂时不可用</strong>
            <p>{documentsError}</p>
            <button type="button" className="secondary-button" onClick={() => void refreshDocuments()}>重新加载</button>
          </div>
        ) : documentsLoading && documents.length === 0 ? (
          <div className="list-state" role="status"><span className="spinner dark" aria-hidden="true" /><p>正在读取本地资料…</p></div>
        ) : documents.length === 0 ? (
          <div className="list-state">
            <FileText size={26} strokeWidth={1.5} aria-hidden="true" />
            <strong>{publicMode ? '临时资料库还是空的' : '还没有资料'}</strong>
            <p>
              {publicMode
                ? '添加的资料只属于当前标签页，关闭页面或结束体验后会被清除。'
                : '上传第一份文件后，就可以开始提问。'}
            </p>
            <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()} disabled={uploadBlocked} title={health?.upload_blocked_reason ?? undefined}>上传资料</button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="documents-table">
              <thead><tr><th>文件名</th><th>大小</th><th>片段</th><th>上传时间</th>{!publicMode && <th><span className="sr-only">操作</span></th>}</tr></thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td data-label="文件名">
                      <button type="button" className="document-name" onClick={() => void openDocument(document)} title="查看资料片段">
                        <span className="file-icon"><FileText size={17} strokeWidth={1.7} aria-hidden="true" /></span>
                        <span>{document.name}</span>
                      </button>
                    </td>
                    <td data-label="大小">{formatSize(document.size)}</td>
                    <td data-label="片段"><span className="chunk-count">{document.chunk_count}</span></td>
                    <td data-label="上传时间"><time dateTime={document.created_at}>{formatDate(document.created_at)}</time></td>
                    {!publicMode && (
                      <td className="delete-cell">
                        <button type="button" className="icon-button danger-button" onClick={() => { setDeleteTarget(document); setDeleteError(null); }} aria-label={`删除 ${document.name}`} title="删除资料">
                          <Trash2 size={16} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Dialog
        open={Boolean(selectedDocument)}
        onClose={closeDocument}
        title={selectedDocument?.name ?? '资料片段'}
        description={selectedDocument ? `${selectedDocument.chunk_count} 个原文片段 · 保留上传时的文本内容` : undefined}
      >
        {chunksLoading ? (
          <div className="dialog-state" role="status"><span className="spinner dark" aria-hidden="true" /><p>正在读取资料片段…</p></div>
        ) : chunksError ? (
          <div className="dialog-state error-state" role="alert"><XCircle size={24} aria-hidden="true" /><p>{chunksError}</p>{selectedDocument && <button type="button" className="secondary-button" onClick={() => void openDocument(selectedDocument)}>重试</button>}</div>
        ) : chunks.length === 0 ? (
          <div className="dialog-state"><FileText size={24} aria-hidden="true" /><p>这份资料没有可显示的文本片段。</p></div>
        ) : (
          <div className="chunk-list">
            {chunks.map((chunk) => (
              <article className="chunk-item" key={chunk.id}>
                <div className="chunk-label">
                  {chunk.page !== null && <span>第 {chunk.page} 页</span>}
                  <span>片段 {chunk.chunk_index + 1}</span>
                </div>
                <p>{chunk.text}</p>
              </article>
            ))}
          </div>
        )}
      </Dialog>

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

      {publicMode && (
        <Dialog
          open={endOpen}
          onClose={() => { if (!ending) setEndOpen(false); }}
          title="结束体验并清空？"
          description="本次体验添加的资料和索引会被永久删除，无法恢复。今天的上传额度不会返还。"
          variant="confirm"
        >
          {endError && <div className="inline-alert error" role="alert"><p>{endError}</p></div>}
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={() => setEndOpen(false)} disabled={ending}>取消</button>
            <button type="button" className="danger-solid-button" onClick={() => void confirmEndExperience()} disabled={ending}>
              {ending && <span className="spinner" aria-hidden="true" />}{ending ? '正在清空' : '确认清空'}
            </button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
