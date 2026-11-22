import type {
  AskResponse,
  ChunksResponse,
  ConnectionProvider,
  ConnectionResponse,
  ConnectionsStatus,
  DocumentRecord,
  DocumentsResponse,
  Health,
  QueryRequest,
  RetrievalResult,
} from './types';

const SESSION_HEADER = 'x-findanswer-session';
const SESSION_STORAGE_KEY = 'findanswer.session';

let activeSessionId: string | null = null;
let pendingSession: Promise<string> | null = null;
let pendingRenewal: Promise<string> | null = null;

function apiRoot(): string {
  const configured = import.meta.env.VITE_API_ROOT as string | undefined;
  return configured ? configured.replace(/\/$/, '') : '/api';
}

function offlineMessage(): string {
  return import.meta.env.VITE_API_ROOT
    ? '无法连接临时资料库，请稍后重试。'
    : '无法连接本地服务。请确认后端已在 127.0.0.1:8000 启动。';
}

export function isPublicRuntime(): boolean {
  return Boolean(import.meta.env.VITE_API_ROOT);
}

function readSessionId(): string | null {
  return activeSessionId;
}

function writeSessionId(id: string): void {
  activeSessionId = id;
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, id);
  } catch {
    // The in-memory id still keeps this page on one session when storage is
    // blocked; only a full reload would start over.
  }
}

function clearSessionId(): void {
  activeSessionId = null;
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Ignore: nothing to clean up when storage is blocked.
  }
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

export function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'session_expired';
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'detail' in payload) {
    const detail = (payload as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) => {
          if (item && typeof item === 'object' && 'msg' in item) {
            return String((item as { msg: unknown }).msg);
          }
          return '';
        })
        .filter(Boolean);
      if (messages.length) return messages.join('；');
    }
  }
  return fallback;
}

function errorCode(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object' && 'code' in payload) {
    const code = (payload as { code: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return undefined;
}

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

async function createSession(): Promise<string> {
  const response = await fetch(`${apiRoot()}/sessions`, { method: 'POST' });
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as { session_id: string };
  writeSessionId(payload.session_id);
  return payload.session_id;
}

// Every page instance owns one server-side session. A reload or a duplicated
// tab never adopts an earlier page's id, so each visitor starts from an empty
// library; the in-memory id keeps all requests on the same session.
export function ensureSession(): Promise<string> {
  if (!isPublicRuntime()) return Promise.resolve('');
  if (activeSessionId) return Promise.resolve(activeSessionId);
  if (!pendingSession) {
    pendingSession = createSession().finally(() => {
      pendingSession = null;
    });
  }
  return pendingSession;
}

// Concurrent 401s share one replacement session instead of creating several.
function renewSession(): Promise<string> {
  clearSessionId();
  if (!pendingRenewal) {
    pendingRenewal = ensureSession().finally(() => {
      pendingRenewal = null;
    });
  }
  return pendingRenewal;
}

function withSessionHeader(init: RequestInit | undefined, sessionId: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(SESSION_HEADER, sessionId);
  return { ...init, headers };
}

async function request<T>(
  path: string,
  init?: RequestInit,
  options: { retryOnExpired?: boolean } = {},
): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const mayRetry = options.retryOnExpired ?? method === 'GET';

  let requestInit = init;
  if (isPublicRuntime()) {
    try {
      requestInit = withSessionHeader(init, await ensureSession());
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(offlineMessage());
    }
  }

  let response: Response;
  try {
    response = await fetch(`${apiRoot()}${path}`, requestInit);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(offlineMessage());
  }

  if (!response.ok) {
    const error = await parseError(response.clone());
    if (isPublicRuntime() && mayRetry && isSessionExpired(error)) {
      await renewSession();
      return request<T>(path, init, { retryOnExpired: false });
    }
    throw error;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function jsonInit(body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  };
}

export function getHealth(signal?: AbortSignal): Promise<Health> {
  return request<Health>('/health', { signal });
}

export function getConnectionsStatus(signal?: AbortSignal): Promise<ConnectionsStatus> {
  return request<ConnectionsStatus>('/connections/status', { signal });
}

export function saveConnection(
  provider: ConnectionProvider,
  apiKey: string,
): Promise<ConnectionResponse> {
  return request<ConnectionResponse>(`/connections/${provider}`, {
    ...jsonInit({ api_key: apiKey }),
    method: 'PUT',
  });
}

export function getDocuments(signal?: AbortSignal): Promise<DocumentsResponse> {
  return request<DocumentsResponse>('/documents', { signal });
}

export function getDocumentChunks(id: string, signal?: AbortSignal): Promise<ChunksResponse> {
  return request<ChunksResponse>(`/documents/${encodeURIComponent(id)}/chunks`, { signal });
}

export function deleteDocument(id: string): Promise<void> {
  return request<void>(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function searchDocuments(body: QueryRequest, signal?: AbortSignal): Promise<RetrievalResult> {
  return request<RetrievalResult>('/search', jsonInit(body, signal));
}

export function askQuestion(body: QueryRequest, signal?: AbortSignal): Promise<AskResponse> {
  return request<AskResponse>('/ask', jsonInit(body, signal));
}

// Ends the current experience: the server deletes every document, chunk,
// reservation and object for this tab, then issues a fresh empty session.
export async function endSession(): Promise<void> {
  if (!isPublicRuntime()) throw new ApiError('本地模式不需要结束体验。');
  try {
    const info = await request<{ session_id: string }>('/session', { method: 'DELETE' });
    writeSessionId(info.session_id);
  } catch (error) {
    if (isSessionExpired(error)) {
      // The server already dropped the expired session; start a new one.
      await renewSession();
      return;
    }
    throw error;
  }
}

// Best-effort cleanup when the tab goes away. `keepalive` lets the DELETE
// outlive the page; the replacement session is never needed by this tab.
export function endSessionOnUnload(): void {
  if (!isPublicRuntime()) return;
  const sessionId = readSessionId();
  if (!sessionId) return;
  try {
    void fetch(`${apiRoot()}/session`, {
      method: 'DELETE',
      keepalive: true,
      headers: { [SESSION_HEADER]: sessionId },
    }).catch(() => {});
  } catch {
    // Nothing to do while the page is unloading.
  }
}

export function registerUnloadCleanup(): () => void {
  if (!isPublicRuntime() || typeof window === 'undefined') return () => {};
  const handler = (event: PageTransitionEvent) => {
    if (event.persisted) return;
    endSessionOnUnload();
  };
  window.addEventListener('pagehide', handler);
  return () => window.removeEventListener('pagehide', handler);
}

function sendUpload(
  file: File,
  onProgress: (percentage: number) => void,
  batchId: string | undefined,
  sessionId: string | null,
): Promise<DocumentRecord> {
  return new Promise<DocumentRecord>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const data = new FormData();
    data.append('file', file);
    if (batchId) data.append('batch_id', batchId);

    xhr.open('POST', `${apiRoot()}/documents`);
    xhr.responseType = 'json';
    if (sessionId) xhr.setRequestHeader(SESSION_HEADER, sessionId);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve(xhr.response as DocumentRecord);
        return;
      }
      const fallback = `上传失败（${xhr.status}）`;
      reject(new ApiError(
        errorMessage(xhr.response as unknown, fallback),
        xhr.status,
        errorCode(xhr.response),
      ));
    });

    xhr.addEventListener('error', () => reject(new ApiError(offlineMessage())));
    xhr.addEventListener('abort', () => reject(new ApiError('上传已取消。')));
    xhr.send(data);
  });
}

export async function uploadDocument(
  file: File,
  onProgress: (percentage: number) => void,
  batchId?: string,
): Promise<DocumentRecord> {
  const sessionId = isPublicRuntime() ? await ensureSession() : null;
  try {
    return await sendUpload(file, onProgress, batchId, sessionId);
  } catch (error) {
    if (!isPublicRuntime() || !isSessionExpired(error)) throw error;
    // The upload never started on a live session, so retrying once is safe.
    const renewed = await renewSession();
    return sendUpload(file, onProgress, batchId, renewed);
  }
}
