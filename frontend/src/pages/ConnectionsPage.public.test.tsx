import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsPage } from './ConnectionsPage.public';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const statusPayload = {
  mode: 'public',
  manage_connections: false,
  note: 'API 为发布者个人 API，密钥保存在服务端，访客无法查看或修改。',
  providers: [
    { provider: 'siliconflow', role: 'embedding', label: '硅基流动', model: 'BAAI/bge-m3', configured: true },
    { provider: 'deepseek', role: 'chat', label: 'DeepSeek', model: 'deepseek-chat', configured: true },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('public ConnectionsPage', () => {
  it('shows provider status without any way to read or change keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(statusPayload)));

    render(<ConnectionsPage />);

    expect(await screen.findByRole('heading', { name: '硅基流动' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'DeepSeek' })).toBeTruthy();
    expect(screen.getByText('BAAI/bge-m3')).toBeTruthy();
    expect(screen.getByText('deepseek-chat')).toBeTruthy();
    expect(screen.getAllByText('发布者已配置')).toHaveLength(2);
    expect(screen.getByText(/API 为发布者个人 API/)).toBeTruthy();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByRole('button', { name: '保存并测试' })).toBeNull();
    expect(screen.queryByText(/Windows 凭据管理器/)).toBeNull();
  });

  it('reports a readable error and offers a recheck', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ detail: '服务暂时不可用。' }, 503)));

    render(<ConnectionsPage />);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('服务暂时不可用。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新检查' })).toBeTruthy();
  });
});
