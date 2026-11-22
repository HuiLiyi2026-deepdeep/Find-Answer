export type RuntimeMode = 'local' | 'public';

export interface Capabilities {
  upload: boolean;
  delete: boolean;
  manage_connections: boolean;
}

export interface Quota {
  scope: 'local' | 'shared' | 'session';
  documents_used: number;
  documents_limit: number | null;
  chunks_used: number;
  chunks_limit: number | null;
  daily_uploads_used: number | null;
  daily_upload_limit: number | null;
  daily_uploads_remaining: number | null;
  batch_limit?: number | null;
}

export interface Health {
  status: 'ok';
  mode: RuntimeMode;
  capabilities: Capabilities;
  upload_blocked_reason: string | null;
  trusted_ip: boolean;
  siliconflow_configured: boolean;
  deepseek_configured: boolean;
  models: {
    embeddings: string;
    chat: string;
  };
  document_count: number;
  quota: Quota;
}

export interface DocumentRecord {
  id: string;
  name: string;
  sha256: string;
  size: number;
  chunk_count: number;
  created_at: string;
}

export interface DocumentsResponse {
  documents: DocumentRecord[];
}

export interface SourceChunk {
  id: string;
  document_id: string;
  file_name: string;
  page: number | null;
  chunk_index: number;
  text: string;
}

export interface ChunksResponse {
  document_id: string;
  chunks: SourceChunk[];
}

export interface RetrievalHit extends SourceChunk {
  score: number;
}

export interface RetrievalResult {
  question: string;
  top_k: number;
  score_threshold: number;
  hits: RetrievalHit[];
  count: number;
}

export interface Citation extends Omit<SourceChunk, 'id'> {
  number: number;
  chunk_id: string;
}

export interface AskResponse {
  status: 'answered' | 'no_answer';
  answer: string;
  citations: Citation[];
  retrieval: RetrievalResult;
}

export interface QueryRequest {
  question: string;
  top_k: number;
}

export type ConnectionProvider = 'siliconflow' | 'deepseek';

export interface ConnectionResponse {
  provider: ConnectionProvider;
  configured: true;
  model: string;
}

export interface SessionInfo {
  session_id: string;
  expires_at: string;
}

export interface ConnectionStatusProvider {
  provider: ConnectionProvider;
  role: 'embedding' | 'chat';
  label: string;
  model: string;
  configured: boolean;
}

export interface ConnectionsStatus {
  mode: 'public';
  manage_connections: false;
  note: string;
  providers: ConnectionStatusProvider[];
}
