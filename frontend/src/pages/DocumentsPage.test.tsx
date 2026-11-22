import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceProvider } from '../context/WorkspaceContext';
import { ApiError, deleteDocument, endSession, uploadDocument } from '../lib/api';
import { DocumentsPage } from './DocumentsPage';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    uploadDocument: vi.fn(),
    deleteDocument: vi.fn(),
    endSession: vi.fn(),
  };
});

function healthResponse(): Response {
  return response({
    status: 'ok', siliconflow_configured: true, deepseek_configured: true,
    models: { embeddings: 'test', chat: 'test' }, document_count: 0,
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

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

const publicHealthPayload = {
  status: 'ok', mode: 'public',
  capabilities: { upload: true, delete: false, manage_connections: false },
  upload_blocked_reason: null, trusted_ip: true,
  siliconflow_configured: true, deepseek_configured: true,
  models: { embeddings: 'test', chat: 'test' }, document_count: 1,
  quota: {
    scope: 'session', documents_used: 1, documents_limit: 20,
    chunks_used: 3, chunks_limit: 200, daily_uploads_used: 2,
    daily_upload_limit: 30, daily_uploads_remaining: 28, batch_limit: 50,
  },
};

function publicHealthResponse(): Response {
  return response(publicHealthPayload);
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

  it('clears the file input value when every selected file is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/health') return healthResponse();
      return response({ documents: [] });
    }));
    render(<WorkspaceProvider><DocumentsPage /></WorkspaceProvider>);
    const fileInput = await screen.findByLabelText('选择文件') as HTMLInputElement;
    // jsdom does not mirror a FileList assigned via fireEvent into the native
    // value getter, so simulate the browser-side dirty value with an own
    // property and assert the component resets the DOM value itself.
    Object.defineProperty(fileInput, 'value', {
      configurable: true, writable: true, value: 'C:\\fakepath\\virus.exe',
    });
    const exe = new File(['binary'], 'virus.exe');

    fireEvent.change(fileInput, { target: { files: [exe] } });

    await screen.findByText('跳过 1');
    expect(uploadDocument).not.toHaveBeenCalled();
    expect(fileInput.value).toBe('');
  });

  it('clears a stale delete success message when a new upload starts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/health') return healthResponse();
      return response({
        documents: [{
          id: 'doc-1', name: 'old.txt', sha256: 'sha-1', size: 12,
          chunk_count: 2, created_at: '2026-10-30T00:00:00Z',
        }],
      });
    }));
    vi.mocked(deleteDocument).mockResolvedValue(undefined);
    vi.mocked(uploadDocument).mockImplementation(async (file) => ({
      id: file.name, name: file.name, sha256: file.name, size: file.size,
      chunk_count: 1, created_at: '2026-10-30T00:00:00Z',
    }));
    render(<WorkspaceProvider><DocumentsPage /></WorkspaceProvider>);

    fireEvent.click(await screen.findByLabelText('删除 old.txt'));
    fireEvent.click(await screen.findByRole('button', { name: '确认删除' }));
    expect(await screen.findByText(/已从资料库删除/)).toBeTruthy();

    const note = new File(['text'], 'note.txt');
    fireEvent.change(await screen.findByLabelText('选择文件'), {
      target: { files: [note] },
    });

    await screen.findByText('成功 1');
    expect(screen.queryByText(/已从资料库删除/)).toBeNull();
  });

  it('shows temporary quota, hides deletion and stops at a terminal quota error', async () => {
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
        throw new ApiError('今日上传额度已用完，请明天再试。', 429, 'daily_limit');
      }
      return {
        id: file.name, name: file.name, sha256: file.name, size: file.size,
        chunk_count: 1, created_at: '2026-10-30T00:00:00Z',
      };
    });

    render(<WorkspaceProvider><DocumentsPage /></WorkspaceProvider>);

    expect(await screen.findByText(/临时资料库只属于当前标签页/)).toBeTruthy();
    expect(screen.getByText(/请勿上传隐私或机密资料/)).toBeTruthy();
    expect(screen.getByText(/本次体验 1\/20 份/)).toBeTruthy();
    expect(screen.getByText(/今日剩余 28\/30/)).toBeTruthy();
    expect(
      screen.getByLabelText('临时资料库配额').textContent?.replace(/\s+/g, ' ').trim(),
    ).toBe('本次体验 1/20 份 · 片段 3/200 · 今日剩余 28/30');
    expect(screen.queryByLabelText('删除 shared.txt')).toBeNull();
    expect(screen.getByRole('button', { name: '结束体验并清空' })).toBeTruthy();

    fireEvent.change(await screen.findByLabelText('选择文件'), {
      target: { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] },
    });

    await screen.findByText('未处理 1');
    expect(uploadDocument).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText(/今日上传额度已用完/).length).toBeGreaterThan(0);
  });

  it('ends the experience only after confirmation and clears the temporary library', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/health') return publicHealthResponse();
      return response({
        documents: [{
          id: 'shared-1', name: 'shared.txt', sha256: 'sha-1', size: 12,
          chunk_count: 1, created_at: '2026-10-30T00:00:00Z',
        }],
      });
    }));
    vi.mocked(endSession).mockResolvedValue(undefined);

    render(<WorkspaceProvider><DocumentsPage /></WorkspaceProvider>);

    fireEvent.click(await screen.findByRole('button', { name: '结束体验并清空' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('本次体验添加的资料和索引会被永久删除，无法恢复。今天的上传额度不会返还。');
    expect(endSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));

    expect(await screen.findByText('临时资料库已清空，可以重新开始。')).toBeTruthy();
    expect(endSession).toHaveBeenCalledTimes(1);
  });

  it('disables upload and shows the reason when the public library blocks it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/health') {
        return response({
          ...publicHealthPayload,
          upload_blocked_reason: '无法确认客户端 IP，暂时不能上传。',
        });
      }
      return response({ documents: [] });
    }));

    render(<WorkspaceProvider><DocumentsPage /></WorkspaceProvider>);

    expect(await screen.findByText(/无法确认客户端 IP/)).toBeTruthy();
    for (const button of screen.getAllByRole('button', { name: '上传资料' })) {
      expect(button.hasAttribute('disabled')).toBe(true);
    }
    expect(screen.getByRole('button', { name: '选择文件' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '选择文件夹' }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(await screen.findByLabelText('选择文件'), {
      target: { files: [new File(['a'], 'a.txt')] },
    });

    expect(uploadDocument).not.toHaveBeenCalled();
    expect(screen.getAllByText(/无法确认客户端 IP/).length).toBeGreaterThan(0);
  });
});
