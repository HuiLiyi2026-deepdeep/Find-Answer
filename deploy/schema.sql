CREATE TABLE app.visitor_sessions (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE app.visitor_documents (
  id uuid PRIMARY KEY,
  session_id text NOT NULL,
  name text NOT NULL,
  sha256 text NOT NULL,
  size bigint NOT NULL,
  chunk_count integer NOT NULL,
  object_path text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE app.visitor_chunks (
  chunk_key text PRIMARY KEY,
  session_id text NOT NULL,
  document_id uuid NOT NULL,
  file_name text NOT NULL,
  page integer,
  chunk_index integer NOT NULL,
  text text NOT NULL,
  embedding text NOT NULL,
  norm text NOT NULL
);
CREATE TABLE app.visitor_reservations (
  id uuid PRIMARY KEY,
  session_id text NOT NULL,
  document_id uuid NOT NULL,
  sha256 text NOT NULL,
  object_path text NOT NULL,
  state text NOT NULL,
  batch_id text NOT NULL,
  ip_day text NOT NULL,
  ip_hash text NOT NULL,
  daily_key text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  chunk_count integer
);
CREATE TABLE app.visitor_ip_daily (
  id text PRIMARY KEY,
  ip_day text NOT NULL,
  ip_hash text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE app.visitor_batch_attempts (
  attempt_key text PRIMARY KEY,
  session_id text NOT NULL,
  batch_id text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX visitor_documents_session_sha_idx ON app.visitor_documents (session_id, sha256);
CREATE INDEX visitor_documents_session_idx ON app.visitor_documents (session_id);
CREATE INDEX visitor_chunks_session_document_idx ON app.visitor_chunks (session_id, document_id);
CREATE INDEX visitor_reservations_session_idx ON app.visitor_reservations (session_id);
CREATE INDEX visitor_ip_daily_day_idx ON app.visitor_ip_daily (ip_day, ip_hash);
CREATE INDEX visitor_attempts_session_batch_idx ON app.visitor_batch_attempts (session_id, batch_id);
CREATE INDEX visitor_sessions_expiry_idx ON app.visitor_sessions (expires_at);
