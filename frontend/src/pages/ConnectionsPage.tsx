import { ArrowRight, Check, Database, KeyRound, Layers3, MessageSquareText, RefreshCw, ServerOff, Settings2 } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useWorkspace } from '../context/WorkspaceContext';
import { saveConnection } from '../lib/api';
import type { ConnectionProvider } from '../lib/types';

interface ConnectionCardProps {
  provider: ConnectionProvider;
  eyebrow: string;
  title: string;
  description: string;
  vendor: string;
  model: string;
  configured: boolean;
  healthAvailable: boolean;
  healthLoading: boolean;
  onSaved: () => Promise<void>;
}

function ConnectionCard({
  provider,
  eyebrow,
  title,
  description,
  vendor,
  model,
  configured,
  healthAvailable,
  healthLoading,
  onSaved,
}: ConnectionCardProps) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const titleId = `${provider}-title`;
  const inputId = `${provider}-api-key`;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedKey = apiKey.trim();
    if (!normalizedKey || saving) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await saveConnection(provider, normalizedKey);
      setApiKey('');
      setSuccess(`${title}已连接，密钥已保存到 Windows 凭据管理器。`);
      await onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '连接保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="connection-card" aria-labelledby={titleId}>
      <div className="provider-topline">
        <span className="provider-icon">
          {provider === 'siliconflow'
            ? <Layers3 size={22} strokeWidth={1.6} aria-hidden="true" />
            : <MessageSquareText size={22} strokeWidth={1.6} aria-hidden="true" />}
        </span>
        <span className={`configuration-status${configured ? ' configured' : ''}`}>
          {configured ? <Check size={13} aria-hidden="true" /> : <span className="warning-dot" aria-hidden="true" />}
          {healthAvailable ? configured ? '已配置' : '未配置' : healthLoading ? '检查中' : '状态未知'}
        </span>
      </div>
      <div className="provider-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h2 id={titleId}>{title}</h2>
        <p>{description}</p>
      </div>
      <dl className="model-details">
        <div><dt>提供方</dt><dd>{vendor}</dd></div>
        <div><dt>当前模型</dt><dd>{model}</dd></div>
        <div><dt>存储位置</dt><dd>Windows 凭据管理器</dd></div>
      </dl>
      <form className="connection-form" onSubmit={(event) => void handleSubmit(event)}>
        <label htmlFor={inputId}>{title} API 密钥</label>
        <input
          id={inputId}
          type="password"
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setError(null);
            setSuccess(null);
          }}
          placeholder={configured ? '输入新密钥以替换已保存密钥' : '粘贴 API 密钥'}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={saving}
          required
        />
        <button type="submit" className="primary-button" disabled={saving || !apiKey.trim()}>
          {saving ? <span className="spinner" aria-hidden="true" /> : <KeyRound size={15} aria-hidden="true" />}
          {saving ? '正在测试并保存' : '保存并测试'}
        </button>
        <p className="connection-form-note">保存时会调用一次真实 API 验证连接；已有密钥不会被读取或回显。</p>
        {error && <p className="connection-feedback error" role="alert">{error}</p>}
        {success && <p className="connection-feedback success" role="status">{success}</p>}
      </form>
    </section>
  );
}

export function ConnectionsPage() {
  const { health, healthLoading, healthError, refreshHealth } = useWorkspace();

  return (
    <main className="page connections-page">
      <header className="page-header connections-header">
        <div>
          <p className="eyebrow">本地服务与模型</p>
          <h1>模型连接</h1>
          <p>密钥仅发送至本机后端并保存到 Windows 凭据管理器，不会回显或保存在浏览器中。</p>
        </div>
        <button type="button" className="secondary-button recheck-button" onClick={() => void refreshHealth()} disabled={healthLoading}>
          <RefreshCw size={16} className={healthLoading ? 'rotating' : ''} aria-hidden="true" />
          {healthLoading ? '正在检查' : '重新检查'}
        </button>
      </header>

      {healthError && (
        <div className="connection-offline" role="alert">
          <ServerOff size={22} strokeWidth={1.6} aria-hidden="true" />
          <div><strong>无法读取本地服务状态</strong><p>{healthError}</p></div>
        </div>
      )}

      <div className="connection-grid">
        <ConnectionCard
          provider="siliconflow"
          eyebrow="嵌入模型"
          title="硅基流动"
          vendor="SiliconFlow"
          description="将资料片段和问题转换为向量，供本地 Chroma 计算语义相似度。"
          model={health?.models.embeddings ?? '未获取'}
          configured={health?.siliconflow_configured ?? false}
          healthAvailable={health !== null}
          healthLoading={healthLoading}
          onSaved={refreshHealth}
        />
        <ConnectionCard
          provider="deepseek"
          eyebrow="回答模型"
          title="DeepSeek"
          vendor="DeepSeek"
          description="仅阅读本地检索返回的资料原文，生成带引用编号的回答；依据不足时明确拒答。"
          model={health?.models.chat ?? '未获取'}
          configured={health?.deepseek_configured ?? false}
          healthAvailable={health !== null}
          healthLoading={healthLoading}
          onSaved={refreshHealth}
        />
      </div>

      <section className="responsibility-section" aria-labelledby="responsibility-title">
        <div className="section-heading">
          <div><p className="eyebrow">一次提问的路径</p><h2 id="responsibility-title">检索在本地，回答有边界</h2></div>
        </div>
        <div className="responsibility-flow">
          <div className="flow-step">
            <span className="flow-icon"><Layers3 size={18} aria-hidden="true" /></span>
            <div><strong>01 · 创建嵌入</strong><p>SiliconFlow 处理资料与问题的向量表示。</p></div>
          </div>
          <ArrowRight className="flow-arrow" size={18} aria-hidden="true" />
          <div className="flow-step">
            <span className="flow-icon"><Database size={18} aria-hidden="true" /></span>
            <div><strong>02 · 本地检索</strong><p>Chroma 在本地返回达到阈值的原文片段。</p></div>
          </div>
          <ArrowRight className="flow-arrow" size={18} aria-hidden="true" />
          <div className="flow-step">
            <span className="flow-icon"><MessageSquareText size={18} aria-hidden="true" /></span>
            <div><strong>03 · 依据作答</strong><p>DeepSeek 只使用这些片段回答并标注引用。</p></div>
          </div>
        </div>
      </section>

      <section className="setup-section" aria-labelledby="setup-title">
        <div className="setup-heading">
          <span className="setup-icon"><Settings2 size={20} strokeWidth={1.7} aria-hidden="true" /></span>
          <div><p className="eyebrow">网页配置</p><h2 id="setup-title">两条密钥，分别验证</h2></div>
        </div>
        <ol className="setup-steps">
          <li><span>1</span><p>在对应卡片中粘贴硅基流动或 DeepSeek 的 API 密钥。</p></li>
          <li><span>2</span><p>点击“保存并测试”。测试失败时不会替换当前可用密钥。</p></li>
          <li><span>3</span><p>保存成功后立即生效，无需重启；更换密钥时重复此操作即可。</p></li>
        </ol>
        <div className="restart-note"><KeyRound size={16} aria-hidden="true" /><p>密钥只写入当前 Windows 用户的凭据管理器，不会进入前端持久化、健康检查或日志。</p></div>
      </section>
    </main>
  );
}
