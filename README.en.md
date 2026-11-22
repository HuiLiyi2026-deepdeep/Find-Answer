# FindAnswer

[![CI](https://github.com/HuiLiyi2026-deepdeep/Find-Answer/actions/workflows/ci.yml/badge.svg)](https://github.com/HuiLiyi2026-deepdeep/Find-Answer/actions/workflows/ci.yml)

> Find the answer that is actually in your documents.

A local-first, citation-strict RAG workbench. Answers come only from the materials you provide, every conclusion links back to the source text, and the app refuses to answer when the evidence is insufficient instead of falling back to model knowledge.

English | [简体中文](README.md)

Live demo: <https://findanswer-o0xytkkkwm9.qoder.zone> (anonymous temporary library — do not upload private or confidential files)

## Why FindAnswer

General-purpose chat models tend to turn "I don't know" into a confident answer. FindAnswer constrains every answer to retrieved passages and makes each citation expandable so the source can be checked. It fits document lookup, course revision, and policy/spec reading, where a wrong answer is worse than no answer.

## Guarantees

- **Evidence only**: answers include the real file name, page or chunk number, and source text.
- **Refuse without evidence**: when retrieval scores fall below the threshold, the service returns a fixed refusal and never calls the chat model.
- **Citation validation**: missing, out-of-range, malformed, or mixed valid/invalid citations reject the entire answer.
- **No key echo**: keys never appear in health responses, logs, frontend persistence, or browser storage.
- **No chat history**: neither the local app nor the public site stores question/answer conversations.

## Features

- TXT, Markdown, and text-based PDF (20 MiB per file).
- Single-file and recursive folder upload; up to 100 eligible files per local batch and 50 per public batch.
- SHA-256 deduplication; folder uploads are scheduled serially and one failure does not stop the batch.
- Ask page with answer/refusal state, retrieved passages, and expandable citations.
- Documents page with upload, delete, indexing status, and chunk preview.
- Connections page to save and test SiliconFlow and DeepSeek keys separately.
- Windows portable build using a native WebView2 window — no terminal and no external browser.
- Public mode gives each visitor an isolated temporary library: 20 documents / 200 chunks, cleared when the session ends or expires.

## Architecture

```text
Local
React + Vite ──HTTP──> FastAPI ──> SQLite (document and chunk metadata)
                           ├────> Chroma (local vector index)
                           └────> SiliconFlow Embeddings / DeepSeek Chat

Public (Qoder Sites)
React ──> Sites Function ──> Sites Database (sessions, documents, chunks, vectors)
                        ├──> Sites Storage (original files)
                        └──> SiliconFlow / DeepSeek (server-side Secrets)
```

Retrieval uses cosine similarity, Top-K, and a configurable threshold. Numbered passages are sent to DeepSeek only when valid evidence exists. Public mode performs retrieval and quota reservation within the visitor's session to preserve isolation.

## Quick start

### Windows portable build

1. Download `FindAnswer-win11-x64.zip` from [Releases](https://github.com/HuiLiyi2026-deepdeep/Find-Answer/releases) and extract it.
2. Double-click `FindAnswer.exe`. The app window opens directly, with no terminal and no external browser.
3. On first use, save both API keys on the Connections page; each key is verified against the real API before it is stored.

Runtime data lives in `%LOCALAPPDATA%\FindAnswer\data`, and logs are written to `%LOCALAPPDATA%\FindAnswer\logs\desktop.log`. Closing the window exits the app. Windows 11 normally includes WebView2; if it is missing, install the Microsoft Edge WebView2 Evergreen Runtime. The portable build is not code-signed, so SmartScreen may warn.

### Local development

Requires Python 3.12 (verified on 3.12.10) and Node.js 20.19+.

```bash
# Backend
cd backend
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000

# Frontend (second terminal)
cd frontend
npm install
npm run dev
```

Open <http://127.0.0.1:5173> and save your keys on the Connections page. You can also run `start-dev.bat` to launch both sides; `FindAnswer.lnk` starts them hidden and reuses services that are already running.

### Configuration

Normal use needs no `.env` file. These environment variables are optional advanced settings and take precedence over saved credentials:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SILICONFLOW_API_KEY` | empty | SiliconFlow key |
| `DEEPSEEK_API_KEY` | empty | DeepSeek key |
| `SILICONFLOW_EMBEDDING_MODEL` | `BAAI/bge-m3` | Embedding model |
| `DEEPSEEK_MODEL` | `deepseek-chat` | Chat model |
| `FINDANSWER_DATA_DIR` | `backend/data` | Local data directory |
| `FINDANSWER_RETRIEVAL_THRESHOLD` | `0.25` | Retrieval similarity threshold |
| `DEFAULT_TOP_K` | `5` | Default number of retrieved chunks |
| `CHUNK_SIZE` | `600` | Chunk length |
| `CHUNK_OVERLAP` | `80` | Chunk overlap |

## Tests

```bash
# Backend (58 tests)
cd backend && python -m pytest

# Frontend (26 tests)
cd frontend && npm test

# Public Function harness (121 tests)
node --test public-harness/tests/*.test.mjs

# Launcher script tests
powershell -ExecutionPolicy Bypass -File scripts/tests/StartFindAnswer.Tests.ps1

# Evaluation: offline contract check (no keys, runs in CI)
python eval/run_eval.py --mode offline

# Evaluation: real quality baseline (requires local keys)
python eval/run_eval.py --mode live --report eval/report-live.json
```

Dataset schema and metric thresholds are documented in [eval/README.md](eval/README.md). CI runs backend tests, the offline evaluation, frontend tests and build, and the public harness on every push and pull request.

## Build the Windows package

```powershell
powershell -ExecutionPolicy Bypass -File packaging/build.ps1
```

The script builds the local-mode frontend, prepares an isolated build environment, produces the windowed PyInstaller app, and writes `packaging/out/FindAnswer-win11-x64.zip`. Build artifacts are not committed to git; distribute them through Releases.

## Project layout

```text
backend/            FastAPI backend, SQLite/Chroma, desktop entry point
frontend/           React + Vite workbench (local and public modes)
functions/          Qoder Sites Function (public backend)
deploy/schema.sql   Public database schema
public-harness/     Local harness and tests for the public Function
eval/               Retrieval/refusal dataset, offline contract and live baseline
packaging/          PyInstaller spec, build script, and user notes
scripts/            Launchers and launcher tests
docs/               Design documents and implementation plans
```

## Scope and trade-offs

- Text-based PDF only; no OCR, table understanding, or image description.
- Retrieval is single-path vector recall with a fixed threshold; no reranking, hybrid search, or query rewriting.
- Public mode computes cosine similarity within a session and is bounded by the 200-chunk cap; local mode uses Chroma.
- Public mode is an anonymous temporary library with no accounts; cleanup relies on the end button and session expiry.
- There is no automated evaluation set yet for recall, citation accuracy, or refusal accuracy.

## Privacy and security

- Uploaded text is sent to SiliconFlow for embeddings; matched passages and the question are sent to DeepSeek for answering.
- Local keys are stored in the current Windows user's Credential Manager; public keys live in server-side Secrets.
- Keys are never rendered back to the frontend or written to `localStorage`, `sessionStorage`, or logs.
- Do not upload private, confidential, or unauthorized material.

## Roadmap

- Build a RAG evaluation set covering retrieval, citation accuracy, and refusal accuracy.
- Add CI (tests, type checking, build) and richer runtime observability.
- Evaluate reranking, hybrid retrieval, and query rewriting for citation quality.
- Add OCR and more document formats as needed.