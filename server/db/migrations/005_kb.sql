-- 02-data-model §3 — pgvector, kb_documents, kb_chunks, kb_queries. Do not edit after the first deploy: changes go into a new migration (02 §6).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE kb_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL,                       -- 'handover-date'
  lang          text NOT NULL CHECK (lang IN ('ru','uz','en')),
  title         text NOT NULL,
  topic         text NOT NULL,                       -- сроки, материалы, паркинг, … (§09.2)
  path          text NOT NULL,                       -- kb/ru/handover-date.md
  content_hash  text NOT NULL,                       -- sha256 файла: не менялся — не переиндексируем (NFR-COST-04)
  updated_at    timestamptz NOT NULL,
  UNIQUE (slug, lang)
);

CREATE TABLE kb_chunks (
  id            bigserial PRIMARY KEY,
  document_id   uuid NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  ord           int  NOT NULL,
  lang          text NOT NULL,
  heading       text NOT NULL,
  text          text NOT NULL,
  content_hash  text NOT NULL,
  embedding     vector(768),                          -- null = эмбеддинг ещё не посчитан
  embed_model   text,                                 -- 'gemini-embedding-001@768'
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('simple', heading || ' ' || text)) STORED,
  UNIQUE (document_id, ord)
);
CREATE INDEX kb_chunks_tsv  ON kb_chunks USING gin (tsv);
CREATE INDEX kb_chunks_lang ON kb_chunks (lang);
-- Векторного индекса (HNSW) нет намеренно: фрагментов < 200, точный перебор быстрее и детерминирован.
-- Если база вырастет > 5 000 фрагментов: CREATE INDEX … USING hnsw (embedding vector_cosine_ops).

CREATE TABLE kb_queries (                             -- журнал поиска: контроль качества, «вопросы без ответа» (C)
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL,
  conversation_id  uuid,
  lang             text,
  query            text NOT NULL,                     -- после redact
  mode             text NOT NULL CHECK (mode IN ('hybrid','keyword_only')),
  top_score        real,
  chunk_ids        bigint[] NOT NULL DEFAULT '{}',
  answered         boolean NOT NULL,                  -- false = честный отказ
  ms               int
);
