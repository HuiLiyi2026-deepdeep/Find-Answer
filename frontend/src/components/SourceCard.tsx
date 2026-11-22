import { FileText } from 'lucide-react';
import type { RetrievalHit } from '../lib/types';

interface SourceCardProps {
  hit: RetrievalHit;
  index: number;
  highlighted?: boolean;
}

export function SourceCard({ hit, index, highlighted = false }: SourceCardProps) {
  return (
    <article
      id={`source-${hit.id}`}
      className={`source-card${highlighted ? ' highlighted' : ''}`}
      tabIndex={-1}
      aria-label={`依据 ${index + 1}，${hit.file_name}`}
    >
      <div className="source-card-topline">
        <span className="source-number">{String(index + 1).padStart(2, '0')}</span>
        <span className="source-score" title="检索相似度">
          相似度 {(hit.score * 100).toFixed(1)}%
        </span>
      </div>
      <div className="source-file">
        <FileText size={15} strokeWidth={1.8} aria-hidden="true" />
        <strong title={hit.file_name}>{hit.file_name}</strong>
      </div>
      <div className="source-meta">
        {hit.page !== null && <span>第 {hit.page} 页</span>}
        <span>片段 {hit.chunk_index + 1}</span>
      </div>
      <p className="source-text">{hit.text}</p>
    </article>
  );
}
