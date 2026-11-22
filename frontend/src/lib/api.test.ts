import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiError } from './api';

function healthPayload(mode: 'local' | 'public') {
  return {
    status: 'ok', mode,
    capabilities: mode === 'public'
      ? { upload: true, delete: false, manage_connections: false }
      : { upload: true, delete: true, manage_connections: true },
    upload_blocked_reason: null, trusted_ip: true,
    siliconflow_configured: false, deepseek_configured: false,
    models: { embeddings: 'e', chat: 'c' }, document_count: 0,
    quota: {
      scope: mode === 'public' ? 'session' : 'local',
      documents_used: 0, documents_limit: mode === 'public' ? 20 : null,
      chunks_used: 0, chunks_limit: mode === 'public' ? 200 : null,
      daily_uploads_used: mode === 'public' ? 0 : null,
      daily_upload_limit: mode === 'public' ? 30 : null,
      daily_uploads_remaining: mode === 'public' ? 30 : null,
    },
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return init?.headers ? new Headers(init.headers).get(name) : null;
}

const SESSION_HEADER = 'x-findanswer-session';
const SESSION_KEY = 'findanswer.session';

// Each test loads a fresh copy of the module so its per-page session state
// cannot leak into the next test.
async function loadApi() {
  vi.resetModules();
  return import('./api');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('API root', () => {
  it('uses /api by default and never touches sessions locally', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(healthPayload('local')));
    vi.stubGlobal('fetch', fetchMock);
    const { getHealth } = await loadApi();

    await getHealth();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/health');
    expect(headerOf(fetchMock.mock.calls[0][1], SESSION_HEADER)).toBeNull();
  });

  it('creates one page session before the first public request', async () => {
    vi.stubEnv('VITE_API_ROOT', '/functions/v1/app/api');
    const sessionId = 'a'.repeat(32);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/functions/v1/app/api/sessions') {
        return json({ session_id: sessionId, expires_at: '2026-10-30T02:00:00Z' }, 201);
      }
      return json(healthPayload('public'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getHealth } = await loadApi();

    await getHealth();
    await getHealth();

    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls).toEqual([
      '/functions/v1/app/api/sessions',
      '/functions/v1/app/api/health',
      '/functions/v1/app/api/health',
    ]);
    expect(headerOf(fetchMock.mock.calls[1][1], SESSION_HEADER)).toBe(sessionId);
    expect(headerOf(fetchMock.mock.calls[2][1], SESSION_HEADER)).toBe(sessionId);
    expect(sessionStorage.getItem(SESSION_KEY)).toBe(sessionId);
  });

  it('does not adopt a session id inherited from an earlier page', async () => {
    vi.stubEnv('VITE_API_ROOT', '/functions/v1/app/api');
    sessionStorage.setItem(SESSION_KEY, 'b'.repeat(32));
    const fresh = 'c'.repeat(32);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/functions/v1/app/api/sessions') {
        return json({ session_id: fresh, expires_at: '2026-10-30T02:00:00Z' }, 201);
      }
      return json(healthPayload('public'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getHealth } = await loadApi();

    await getHealth();
    expect(fetchMock.mock.calls[0][0]).toBe('/functions/v1/app/api/sessions');
    expect(headerOf(fetchMock.mock.calls[1][1], SESSION_HEADER)).toBe(fresh);
    expect(sessionStorage.getItem(SESSION_KEY)).toBe(fresh);
  });

  it('retries a GET once with a fresh session after session_expired', async () => {
    vi.stubEnv('VITE_API_ROOT', '/functions/v1/app/api');
    const expired = 'd'.repeat(32);
    const fresh = 'e'.repeat(32);
    let sessionsCreated = 0;
    let healthCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/functions/v1/app/api/sessions') {
        sessionsCreated += 1;
        return json({
          session_id: sessionsCreated === 1 ? expired : fresh,
          expires_at: '2026-10-30T02:00:00Z',
        }, 201);
      }
      healthCalls += 1;
      if (healthCalls === 1) {
        return json({ detail: '体验会话已过期，请刷新页面重新开始。', code: 'session_expired' }, 401);
      }
      return json(healthPayload('public'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getHealth } = await loadApi();

    await getHealth();

    expect(sessionsCreated).toBe(2);
    expect(healthCalls).toBe(2);
    const calls = fetchMock.mock.calls;
    expect(headerOf(calls[1][1], SESSION_HEADER)).toBe(expired);
    expect(headerOf(calls[3][1], SESSION_HEADER)).toBe(fresh);
    expect(sessionStorage.getItem(SESSION_KEY)).toBe(fresh);
  });

  it('shares one replacement session between concurrent expired GETs', async () => {
    vi.stubEnv('VITE_API_ROOT', '/functions/v1/app/api');
    const expired = 'f'.repeat(32);
    const fresh = '1'.repeat(32);
    let sessionsCreated = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/functions/v1/app/api/sessions') {
        sessionsCreated += 1;
        return json({
          session_id: sessionsCreated === 1 ? expired : fresh,
          expires_at: '2026-10-30T02:00:00Z',
        }, 201);
      }
      if (new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers).get(SESSION_HEADER) === expired) {
        return json({ code: 'session_expired' }, 401);
      }
      return json(healthPayload('public'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { getHealth } = await loadApi();

    await Promise.all([getHealth(), getHealth()]);

    expect(sessionsCreated).toBe(2);
  });

  it('does not replay a POST after session_expired', async () => {
    vi.stubEnv('VITE_API_ROOT', '/functions/v1/app/api');
    const sessionId = '2'.repeat(32);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/functions/v1/app/api/sessions') {
        return json({ session_id: sessionId, expires_at: '2026-10-30T02:00:00Z' }, 201);
      }
      return json({ detail: '体验会话已过期，请刷新页面重新开始。', code: 'session_expired' }, 401);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { askQuestion } = await loadApi();

    await expect(askQuestion({ question: '问题', top_k: 5 })).rejects.toMatchObject({
      status: 401,
      code: 'session_expired',
    } satisfies Partial<ApiError>);
    const askCalls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/ask'));
    expect(askCalls).toHaveLength(1);
  });

  it('ends the experience and stores the replacement session', async () => {
    vi.stubEnv('VITE_API_ROOT', '/functions/v1/app/api');
    const oldId = '3'.repeat(32);
    const newId = '4'.repeat(32);
    let sessionsCreated = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/functions/v1/app/api/sessions') {
        sessionsCreated += 1;
        return json({ session_id: oldId, expires_at: '2026-10-30T02:00:00Z' }, 201);
      }
      if (url === '/functions/v1/app/api/session' && init?.method === 'DELETE') {
        return json({ session_id: newId, expires_at: '2026-10-30T02:00:00Z' });
      }
      return json(healthPayload('public'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { endSession, getHealth } = await loadApi();

    await endSession();
    expect(sessionsCreated).toBe(1);
    expect(headerOf(fetchMock.mock.calls[1][1], SESSION_HEADER)).toBe(oldId);
    expect(sessionStorage.getItem(SESSION_KEY)).toBe(newId);

    await getHealth();
    expect(headerOf(fetchMock.mock.calls[2][1], SESSION_HEADER)).toBe(newId);
  });

  it('keeps the error code from a quota response', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json({
      detail: '今日上传额度已用完，请明天再试。',
      code: 'daily_limit',
    }, 429)));
    const { getHealth } = await loadApi();

    await expect(getHealth()).rejects.toMatchObject({
      status: 429,
      code: 'daily_limit',
    } satisfies Partial<ApiError>);
  });

  it('uploads only after the session exists and retries once on session_expired', async () => {
    vi.stubEnv('VITE_API_ROOT', '/functions/v1/app/api');
    const expired = '5'.repeat(32);
    const fresh = '6'.repeat(32);
    let sessionsCreated = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input) === '/functions/v1/app/api/sessions') {
        sessionsCreated += 1;
        return json({
          session_id: sessionsCreated === 1 ? expired : fresh,
          expires_at: '2026-10-30T02:00:00Z',
        }, 201);
      }
      return json({ detail: 'not found' }, 404);
    }));

    const requests: Array<{ header: string | null }> = [];
    class FakeXhr {
      status = 0;
      response: unknown = null;
      responseType = '';
      upload = { addEventListener: () => {} };
      private headers = new Map<string, string>();
      private listeners = new Map<string, Array<() => void>>();
      open() {}
      setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
      addEventListener(type: string, handler: () => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
      }
      send() {
        const header = this.headers.get(SESSION_HEADER) ?? null;
        requests.push({ header });
        if (header === expired) {
          this.status = 401;
          this.response = { code: 'session_expired' };
        } else {
          this.status = 201;
          this.response = {
            id: 'doc-1', name: 'note.txt', sha256: 'sha-1', size: 4,
            chunk_count: 1, created_at: '2026-10-30T00:00:00Z',
          };
        }
        queueMicrotask(() => {
          for (const handler of this.listeners.get('load') ?? []) handler();
        });
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest);
    const { uploadDocument } = await loadApi();

    const document = await uploadDocument(new File(['text'], 'note.txt'), () => {});

    expect(document.id).toBe('doc-1');
    expect(requests).toEqual([{ header: expired }, { header: fresh }]);
  });
});
