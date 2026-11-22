import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '../context/WorkspaceContext';
import { ConnectionsPage } from './ConnectionsPage';
import type { Health } from '../lib/types';

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderPage() {
  return render(
    <WorkspaceProvider>
      <ConnectionsPage />
    </WorkspaceProvider>,
  );
}

describe('ConnectionsPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('tests and saves a key, refreshes status, and clears the secret input', async () => {
    const secret = 'sk-browser-siliconflow';
    let health: Health = {
      status: 'ok',
      siliconflow_configured: false,
      deepseek_configured: false,
      models: { embeddings: 'BAAI/bge-m3', chat: 'deepseek-chat' },
      document_count: 0,
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
    };
    let savedBody = '';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/health') return response(health);
      if (url === '/api/documents') return response({ documents: [] });
      if (url === '/api/connections/siliconflow' && init?.method === 'PUT') {
        savedBody = String(init.body);
        health = { ...health, siliconflow_configured: true };
        return response({ provider: 'siliconflow', configured: true, model: 'BAAI/bge-m3' });
      }
      return response({ detail: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    const input = await screen.findByLabelText('硅基流动 API 密钥');
    const saveButton = screen.getAllByRole('button', { name: '保存并测试' })[0];
    expect(saveButton.hasAttribute('disabled')).toBe(true);
    fireEvent.change(input, { target: { value: secret } });
    fireEvent.click(saveButton);

    await screen.findByText('硅基流动已连接，密钥已保存到 Windows 凭据管理器。');
    await waitFor(() => expect(screen.getAllByText('已配置')).toHaveLength(1));
    expect(savedBody).toBe(JSON.stringify({ api_key: secret }));
    expect((input as HTMLInputElement).value).toBe('');
    expect(input.getAttribute('type')).toBe('password');
    expect(window.localStorage.length).toBe(0);
  });

  it('shows a sanitized provider error and does not persist the key', async () => {
    const secret = 'sk-browser-deepseek';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/health') {
        return response({
          status: 'ok',
          siliconflow_configured: false,
          deepseek_configured: false,
          models: { embeddings: 'BAAI/bge-m3', chat: 'deepseek-chat' },
          document_count: 0,
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
        });
      }
      if (url === '/api/documents') return response({ documents: [] });
      if (url === '/api/connections/deepseek' && init?.method === 'PUT') {
        return response({ detail: 'DeepSeek连接测试失败，请检查密钥后重试。' }, 502);
      }
      return response({ detail: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    const input = await screen.findByLabelText('DeepSeek API 密钥');
    fireEvent.change(input, { target: { value: secret } });
    fireEvent.click(screen.getAllByRole('button', { name: '保存并测试' })[1]);

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('DeepSeek连接测试失败');
    expect(screen.queryByText(/已保存到 Windows/)).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });
});
