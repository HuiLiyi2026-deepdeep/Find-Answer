import { ArrowRight, Check, Database, KeyRound, Layers3, LockKeyhole, MessageSquareText, RefreshCw, ServerOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getConnectionsStatus } from '../lib/api';
import type { ConnectionStatusProvider, ConnectionsStatus } from '../lib/types';

const ROLE_DETAILS: Record<ConnectionStatusProvider['role'], { eyebrow: string; title: string; description: string; modelLabel: string }> = {
  embedding: {
    eyebrow: '嵌入模型',
    title: '硅基流动',
    description: '把资料片段和问题转换成向量，用来计算语义相似度。',
    modelLabel: '当前模型',
  },
  chat: {
    eyebrow: '回答模型',
    title: 'DeepSeek',
    description: '只阅读检索返回的资料原文，生成带引用编号的回答；依据不足时明确拒答。',
    modelLabel: '当前模型',
  },
};

function ProviderCard({ provider }: { provider: ConnectionStatusProvider }) {
  const details = ROLE_DETAILS[provider.role];
  const titleId = `${provider.provider}-title`;
  return (
    <section className="connection-card" aria-labelledby={titleId}>
      <div className="provider-topline">
        <span className="provider-icon">
          {provider.role === 'embedding'
            ? <Layers3 size={22} strokeWidth={1.6} aria-hidden="true" />
            : <MessageSquareText size={22} strokeWidth={1.6} aria-hidden="true" />}
        </span>
        <span className={`configuration-status${provider.configured ? ' configured' : ''}`}>
          {provider.configured ? <Check size={13} aria-hidden="true" /> : <span className="warning-dot" aria-hidden="true" />}
          {provider.configured ? '发布者已配置' : '发布者未配置'}
        </span>
      </div>
      <div className="provider-copy">
        <p className="eyebrow">{details.eyebrow}</p>
        <h2 id={titleId}>{details.title}</h2>
        <p>{details.description}</p>
      </div>
      <dl className="model-details">
        <div><dt>提供方</dt><dd>{provider.label}</dd></div>
        <div><dt>{details.modelLabel}</dt><dd>{provider.model || '未获取'}</dd></div>
        <div><dt>密钥位置</dt><dd>服务端托管</dd></div>
      </dl>
      <p className="connection-form-note">只读状态：访客无法查看或修改密钥。</p>
    </section>
  );
}

export function ConnectionsPage() {
  const [status, setStatus] = useState<ConnectionsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await getConnectionsStatus(controller.signal);
      if (requestId === requestRef.current) setStatus(response);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (requestId === requestRef.current) {
        setStatus(null);
        setError(caught instanceof Error ? caught.message : '无法读取模型连接状态。');
      }
    } finally {
      if (requestId === requestRef.current) {
        controllerRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [refresh]);

  return (
    <main className="page connections-page">
      <header className="page-header connections-header">
        <div>
          <p className="eyebrow">发布者的模型服务</p>
          <h1>模型连接</h1>
          <p>公开体验版使用发布者提供的模型服务。密钥保存在服务端，访客只能查看状态，无法查看或修改。</p>
        </div>
        <button type="button" className="secondary-button recheck-button" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={16} className={loading ? 'rotating' : ''} aria-hidden="true" />
          {loading ? '正在检查' : '重新检查'}
        </button>
      </header>

      <div className="workspace-notice" role="note">
        <KeyRound size={18} strokeWidth={1.7} aria-hidden="true" />
        <div>
          <strong>只读</strong>
          <span>API 为发布者个人 API，密钥保存在服务端，访客无法查看或修改。</span>
        </div>
      </div>

      {error ? (
        <div className="connection-offline" role="alert">
          <ServerOff size={22} strokeWidth={1.6} aria-hidden="true" />
          <div><strong>无法读取模型连接状态</strong><p>{error}</p></div>
        </div>
      ) : loading && !status ? (
        <div className="list-state" role="status">
          <span className="spinner dark" aria-hidden="true" />
          <p>正在读取模型连接状态…</p>
        </div>
      ) : (
        <div className="connection-grid">
          {status?.providers.map((provider) => (
            <ProviderCard key={provider.provider} provider={provider} />
          ))}
        </div>
      )}

      <section className="responsibility-section" aria-labelledby="responsibility-title">
        <div className="section-heading">
          <div><p className="eyebrow">一次提问的路径</p><h2 id="responsibility-title">检索在服务端，回答有边界</h2></div>
        </div>
        <div className="responsibility-flow">
          <div className="flow-step">
            <span className="flow-icon"><Layers3 size={18} aria-hidden="true" /></span>
            <div><strong>01 · 创建嵌入</strong><p>硅基流动处理资料与问题的向量表示。</p></div>
          </div>
          <ArrowRight className="flow-arrow" size={18} aria-hidden="true" />
          <div className="flow-step">
            <span className="flow-icon"><Database size={18} aria-hidden="true" /></span>
            <div><strong>02 · 相似度检索</strong><p>在当前标签页的临时资料库中返回达到阈值的片段。</p></div>
          </div>
          <ArrowRight className="flow-arrow" size={18} aria-hidden="true" />
          <div className="flow-step">
            <span className="flow-icon"><MessageSquareText size={18} aria-hidden="true" /></span>
            <div><strong>03 · 依据作答</strong><p>DeepSeek 只使用这些片段回答并标注引用。</p></div>
          </div>
        </div>
      </section>

      <section className="setup-section" aria-labelledby="readonly-title">
        <div className="setup-heading">
          <span className="setup-icon"><LockKeyhole size={20} strokeWidth={1.7} aria-hidden="true" /></span>
          <div><p className="eyebrow">公开体验版</p><h2 id="readonly-title">为什么不能修改密钥</h2></div>
        </div>
        <ol className="setup-steps">
          <li><span>1</span><p>两条 API 密钥由发布者保存在服务端，不会发送到浏览器。</p></li>
          <li><span>2</span><p>资料上传和提问都会调用发布者的模型额度，请勿上传隐私或机密资料。</p></li>
          <li><span>3</span><p>如需更换模型或密钥，请由发布者在站点设置中维护。</p></li>
        </ol>
      </section>
    </main>
  );
}
