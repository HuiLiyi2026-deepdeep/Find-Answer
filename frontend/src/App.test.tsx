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
    scope: 'session', documents_used: 0, documents_limit: 20,
    chunks_used: 0, chunks_limit: 200, daily_uploads_used: 0,
    daily_upload_limit: 30, daily_uploads_remaining: 30, batch_limit: 50,
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('public routing', () => {
  it('keeps the connections route and shows the temporary library status', async () => {
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

    expect(await screen.findByRole('heading', { name: '模型连接' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '模型连接' })).toBeTruthy();
    expect(screen.getByText('临时资料库已连接')).toBeTruthy();
    expect(screen.getByText('0 份临时资料')).toBeTruthy();
    expect(screen.queryByText('从资料里，找到确切答案。')).toBeNull();
  });
});
