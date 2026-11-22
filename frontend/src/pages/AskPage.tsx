import { motion, useReducedMotion } from 'framer-motion';
import { ArrowUp, BookOpenCheck, ChevronDown, CircleHelp, FileSearch, Files, LockKeyhole, Search, SearchX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { SourceCard } from '../components/SourceCard';
import { useWorkspace } from '../context/WorkspaceContext';
import { askQuestion, isSessionExpired, searchDocuments } from '../lib/api';
import type { AskResponse, Citation, RetrievalHit, RetrievalResult } from '../lib/types';

type QueryMode = 'answer' | 'search';
type QueryResult =
  | { mode: 'answer'; data: AskResponse }
  | { mode: 'search'; data: RetrievalResult };

interface EvidencePanelProps {
  hits: RetrievalHit[];
  threshold: number;
  activeChunkId: string | null;
  emptyCopy: string;
}

function EvidencePanel({ hits, threshold, activeChunkId, emptyCopy }: EvidencePanelProps) {
  return (
    <section className="evidence-panel" aria-labelledby="evidence-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">可追溯原文</p>
          <h2 id="evidence-title">检索依据</h2>
        </div>
        <span className="count-badge">{hits.length} 条</span>
      </div>
      <p className="threshold-note">仅显示相似度达到 {(threshold * 100).toFixed(0)}% 的资料片段</p>
      {hits.length > 0 ? (
        <div className="source-list">
          {hits.map((hit, index) => (
            <SourceCard key={hit.id} hit={hit} index={index} highlighted={activeChunkId === hit.id} />
          ))}
        </div>
      ) : (
        <div className="empty-evidence">
          <SearchX size={22} strokeWidth={1.6} aria-hidden="true" />
          <p>{emptyCopy}</p>
        </div>
      )}
    </section>
  );
}

function AnswerText({ answer, citations, onCitation }: {
  answer: string;
  citations: Citation[];
  onCitation: (citation: Citation) => void;
}) {
  const parts = answer.split(/(\[\d+\]|【\d+】)/g);
  return (
    <p className="answer-text">
      {parts.map((part, index) => {
        const match = part.match(/^(?:\[(\d+)\]|【(\d+)】)$/);
        if (!match) return <span key={index}>{part}</span>;
        const number = Number(match[1] || match[2]);
        const citation = citations.find((item) => item.number === number);
        if (!citation) return <span key={index}>{part}</span>;
        return (
          <button
            type="button"
            className="citation-link"
            key={index}
            onClick={() => onCitation(citation)}
            aria-label={`查看引用 ${citation.number} 的原文`}
          >
            {part}
          </button>
        );
      })}
    </p>
  );
}

export function AskPage() {
  const { documents, documentsLoading, documentsError, health, refreshAll } = useWorkspace();
  const publicMode = health?.mode === 'public';
  const [question, setQuestion] = useState('');
  const [topK, setTopK] = useState(5);
  const [mode, setMode] = useState<QueryMode>('answer');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [activeChunkId, setActiveChunkId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => () => controllerRef.current?.abort(), []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    const trimmed = question.trim();
    if (!trimmed) {
      setInputError('请输入一个问题后再提交。');
      textareaRef.current?.focus();
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setInputError(null);
    setRequestError(null);
    setResult(null);
    setActiveChunkId(null);

    try {
      if (mode === 'answer') {
        const data = await askQuestion({ question: trimmed, top_k: topK }, controller.signal);
        setResult({ mode: 'answer', data });
      } else {
        const data = await searchDocuments({ question: trimmed, top_k: topK }, controller.signal);
        setResult({ mode: 'search', data });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (isSessionExpired(error)) {
        await refreshAll().catch(() => {});
        setRequestError('体验会话已过期，已为你开始新的空资料库，请重新添加资料。');
        return;
      }
      setRequestError(error instanceof Error ? error.message : '请求未完成，请稍后重试。');
    } finally {
      if (controllerRef.current === controller) setLoading(false);
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const handleModeChange = (nextMode: QueryMode) => {
    if (nextMode === mode || loading) return;
    setMode(nextMode);
    setResult(null);
    setRequestError(null);
    setInputError(null);
  };

  const handleCitation = (citation: Citation) => {
    setActiveChunkId(citation.chunk_id);
    window.requestAnimationFrame(() => {
      const card = document.getElementById(`source-${citation.chunk_id}`);
      card?.focus({ preventScroll: true });
      card?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    });
  };

  const retrieval = result?.mode === 'answer' ? result.data.retrieval : result?.data;
  const statusMessage = loading
    ? mode === 'answer' ? '正在检索资料并生成回答。' : '正在检索资料。'
    : result
      ? result.mode === 'answer'
        ? result.data.status === 'answered' ? '回答已生成。' : '资料不足以回答此问题。'
        : `检索完成，共 ${result.data.count} 条依据。`
      : '';

  return (
    <main className="page ask-page">
      <div className={`ask-intro${result ? ' compact' : ''}`}>
        <p className="eyebrow">{publicMode ? '临时资料 · 有据可查' : '本地资料 · 有据可查'}</p>
        <h1>从资料里，找到确切答案。</h1>
        <p>
          {publicMode
            ? 'FindAnswer 只依据当前标签页里的临时资料作答。每个结论都可以回到原文，没有依据时会明确说明；关闭页面或结束体验后，资料会被清除。'
            : 'FindAnswer 只依据你提供的资料作答。每个结论都可以回到原文，没有依据时会明确说明。'}
        </p>
      </div>

      {publicMode && (
        <div className="workspace-notice" role="note">
          <LockKeyhole size={18} strokeWidth={1.7} aria-hidden="true" />
          <div>
            <strong>临时资料库</strong>
            <span>资料只属于当前标签页，关闭页面后会清除。请勿上传隐私或机密资料。问题和命中的资料片段会发送至模型服务。</span>
          </div>
          <Link to="/documents">查看资料库</Link>
        </div>
      )}

      {!documentsLoading && documents.length === 0 && !documentsError && (
        <div className="workspace-notice">
          <Files size={18} strokeWidth={1.7} aria-hidden="true" />
          <div>
            <strong>{publicMode ? '临时资料库还是空的' : '资料库还是空的'}</strong>
            <span>
              {publicMode
                ? '先添加自己的资料，就可以开始提问。'
                : '可以先上传资料，也可以直接提交以查看服务校验结果。'}
            </span>
          </div>
          <Link to="/documents">前往资料库</Link>
        </div>
      )}

      {documentsError && !loading && (
        <div className="inline-alert warning" role="status">
          <span>{documentsError}</span>
        </div>
      )}

      <section className="composer" aria-label="问题输入区">
        <form onSubmit={handleSubmit}>
          <label htmlFor="question" className="sr-only">输入你的问题</label>
          <textarea
            ref={textareaRef}
            id="question"
            value={question}
            onChange={(event) => {
              setQuestion(event.target.value);
              if (inputError) setInputError(null);
            }}
            onKeyDown={handleComposerKeyDown}
            placeholder="输入一个关于资料的问题…"
            rows={4}
            maxLength={2000}
            disabled={loading}
            aria-invalid={Boolean(inputError)}
            aria-describedby={`composer-hint${inputError ? ' question-error' : ''}`}
          />
          <div className="composer-toolbar">
            <div className="composer-options">
              <div className="mode-switch" role="group" aria-label="查询方式">
                <button type="button" className={mode === 'answer' ? 'selected' : ''} aria-pressed={mode === 'answer'} onClick={() => handleModeChange('answer')} disabled={loading}>
                  回答
                </button>
                <button type="button" className={mode === 'search' ? 'selected' : ''} aria-pressed={mode === 'search'} onClick={() => handleModeChange('search')} disabled={loading}>
                  仅检索
                </button>
              </div>
              <label className="topk-select">
                <span>检索</span>
                <select value={topK} onChange={(event) => setTopK(Number(event.target.value))} disabled={loading} aria-label="检索资料数量">
                  <option value={3}>前 3 条</option>
                  <option value={5}>前 5 条</option>
                  <option value={8}>前 8 条</option>
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </label>
            </div>
            <div className="composer-submit">
              <span className={`character-count${question.length > 1800 ? ' visible' : ''}`}>{question.length} / 2000</span>
              <button type="submit" className="primary-button submit-button" disabled={loading}>
                {loading ? <span className="spinner" aria-hidden="true" /> : mode === 'answer' ? <ArrowUp size={17} aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
                <span>{loading ? mode === 'answer' ? '正在回答' : '正在检索' : mode === 'answer' ? '提问' : '检索'}</span>
              </button>
            </div>
          </div>
        </form>
        <div className="composer-footnote" id="composer-hint">
          <span><LockKeyhole size={13} aria-hidden="true" />Enter 提交 · Shift + Enter 换行</span>
          <span>回答仅使用检索到的资料</span>
        </div>
        {inputError && <p className="field-error" id="question-error" role="alert">{inputError}</p>}
      </section>

      <div className="sr-only" role="status" aria-live="polite">{statusMessage}</div>
      {requestError && (
        <div className="inline-alert error" role="alert">
          <CircleHelp size={18} aria-hidden="true" />
          <div><strong>这次请求没有完成</strong><p>{requestError}</p></div>
        </div>
      )}

      {loading && (
        <div className="query-loading" role="status">
          <span className="spinner dark" aria-hidden="true" />
          <div>
            <strong>{mode === 'answer' ? '正在查找依据并组织回答' : '正在检索相关资料'}</strong>
            <span>{mode === 'answer' ? '检索和模型调用可能需要一些时间，请稍候。' : '正在计算问题与资料片段的相似度。'}</span>
          </div>
        </div>
      )}

      {result && retrieval && (
        <motion.section
          className="query-result"
          aria-label="查询结果"
          initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.24 }}
        >
          <div className="result-question">
            <span>当前问题</span>
            <p>{retrieval.question}</p>
          </div>

          {result.mode === 'answer' ? (
            <div className="result-workspace">
              <div className="answer-column">
                {result.data.status === 'answered' ? (
                  <section className="answer-panel" aria-labelledby="answer-title">
                    <div className="panel-heading">
                      <div>
                        <p className="eyebrow">基于资料的回答</p>
                        <h2 id="answer-title">答案</h2>
                      </div>
                      <BookOpenCheck size={22} strokeWidth={1.6} aria-hidden="true" />
                    </div>
                    <AnswerText answer={result.data.answer} citations={result.data.citations} onCitation={handleCitation} />
                    {result.data.citations.length > 0 && <p className="citation-help">点击引用编号，定位对应的资料原文。</p>}
                  </section>
                ) : (
                  <section className="no-answer-panel" aria-labelledby="no-answer-title">
                    <CircleHelp size={24} strokeWidth={1.6} aria-hidden="true" />
                    <p className="eyebrow">依据不足</p>
                    <h2 id="no-answer-title">暂时无法回答</h2>
                    <p className="refusal-text">{result.data.answer}</p>
                    <span>不会补充资料之外的信息。{retrieval.hits.length > 0 ? '你仍可查看右侧检索到的片段。' : ''}</span>
                  </section>
                )}
              </div>
              <EvidencePanel
                hits={retrieval.hits}
                threshold={retrieval.score_threshold}
                activeChunkId={activeChunkId}
                emptyCopy="没有达到相似度阈值的资料片段。"
              />
            </div>
          ) : (
            <div className="search-result-layout">
              <div className="search-result-heading">
                <FileSearch size={20} strokeWidth={1.7} aria-hidden="true" />
                <div><h2>检索结果</h2><p>仅展示相关资料原文，未生成回答。</p></div>
              </div>
              <EvidencePanel
                hits={result.data.hits}
                threshold={result.data.score_threshold}
                activeChunkId={null}
                emptyCopy="未检索到达到阈值的资料，可以换个问法或补充资料。"
              />
            </div>
          )}
        </motion.section>
      )}
    </main>
  );
}
