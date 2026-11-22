#!/usr/bin/env python3
"""FindAnswer 检索与拒答评测。

两种模式：
- offline：确定性字符哈希向量 + 脚本化模型，不联网、不需要 Key，用于 CI 契约检查。
- live：真实 bge-m3 向量与 DeepSeek 回答，需要本地环境变量中的 Key，用于真实质量基线。

评测集只使用 eval/dataset.json 中的合成资料；脚本不会读取 backend/data 下的真实文档。
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import shutil
import statistics
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.chunking import chunk_pages, extract_text  # noqa: E402
from app.rag import RAGService  # noqa: E402
from app.storage import LocalStore  # noqa: E402

TOP_K = 5
CHUNK_SIZE = 600
CHUNK_OVERLAP = 80
# 离线阈值按哈希桩向量的实际分布校准（相关 0.26+，无关 0.20-），只用于契约检查。
THRESHOLD = {"offline": 0.23, "live": 0.25}


class HashedEmbeddings:
    """确定性字符 n-gram 特征哈希，仅用于离线契约检查，不代表真实检索质量。"""

    dimensions = 512

    def __init__(self) -> None:
        self.calls = 0

    async def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls += 1
        return [self._vector(text) for text in texts]

    def _vector(self, text: str) -> list[float]:
        normalized = "".join(text.lower().split())
        vector = [0.0] * self.dimensions
        for size, weight in ((1, 1.0), (2, 2.0)):
            for index in range(len(normalized) - size + 1):
                gram = normalized[index : index + size]
                digest = hashlib.md5(gram.encode("utf-8")).digest()
                bucket = int.from_bytes(digest[:4], "big") % self.dimensions
                vector[bucket] += weight
        norm = math.sqrt(sum(value * value for value in vector))
        if norm == 0:
            return vector
        return [value / norm for value in vector]


class ScriptedChat:
    """离线占位模型：按用例类型模拟“有依据作答”或“依据不足拒答”。"""

    def __init__(self, has_expected_documents: bool) -> None:
        self.has_expected_documents = has_expected_documents
        self.calls = 0

    async def complete(self, messages: list[dict[str, str]]) -> str:
        self.calls += 1
        if not self.has_expected_documents:
            return "NO_ANSWER"
        return "根据资料 [1] 回答。"


class CountingChat:
    def __init__(self, chat) -> None:
        self.chat = chat
        self.calls = 0

    async def complete(self, messages: list[dict[str, str]]) -> str:
        self.calls += 1
        return await self.chat.complete(messages)


def normalize(text: str) -> str:
    return "".join(text.lower().split())


def load_dataset(path: Path) -> dict:
    try:
        dataset = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"评测集不存在：{path}")
    except json.JSONDecodeError as error:
        raise SystemExit(f"评测集不是合法 JSON：{error}")

    documents = dataset.get("documents")
    cases = dataset.get("cases")
    if not isinstance(documents, list) or not documents:
        raise SystemExit("评测集缺少 documents")
    if not isinstance(cases, list) or not cases:
        raise SystemExit("评测集缺少 cases")

    document_ids = [document.get("id") for document in documents]
    if len(set(document_ids)) != len(document_ids):
        raise SystemExit("documents.id 重复")
    for document in documents:
        if not document.get("id") or not document.get("name") or not document.get("text"):
            raise SystemExit("每个 document 都需要 id、name 和 text")
        if not document["name"].lower().endswith((".txt", ".md", ".markdown", ".pdf")):
            raise SystemExit(f"不支持的文档类型：{document['name']}")

    case_ids = set()
    for case in cases:
        case_id = case.get("id")
        if not case_id or case_id in case_ids:
            raise SystemExit(f"case.id 缺失或重复：{case_id!r}")
        case_ids.add(case_id)
        if case.get("kind") not in {"answerable", "unanswerable"}:
            raise SystemExit(f"{case_id}: kind 只能是 answerable 或 unanswerable")
        if not case.get("question"):
            raise SystemExit(f"{case_id}: 缺少 question")
        expected = case.get("expected_documents")
        if not isinstance(expected, list):
            raise SystemExit(f"{case_id}: expected_documents 必须是数组")
        unknown = [item for item in expected if item not in document_ids]
        if unknown:
            raise SystemExit(f"{case_id}: 引用了不存在的文档 {unknown}")
        if case["kind"] == "answerable":
            if not expected:
                raise SystemExit(f"{case_id}: answerable 用例必须声明 expected_documents")
            terms = case.get("expected_terms")
            if not isinstance(terms, list) or not terms:
                raise SystemExit(f"{case_id}: answerable 用例必须声明 expected_terms")
        elif expected:
            raise SystemExit(f"{case_id}: unanswerable 用例不应声明 expected_documents")

    return dataset


async def build_store(dataset: dict, embeddings, data_dir: Path) -> tuple[LocalStore, dict]:
    store = LocalStore(data_dir)
    chunk_info: dict[str, tuple[str, str]] = {}
    for document in dataset["documents"]:
        content = document["text"].encode("utf-8")
        pages = extract_text(document["name"], content)
        chunks = chunk_pages(
            document["id"],
            document["name"],
            pages,
            chunk_size=CHUNK_SIZE,
            overlap=CHUNK_OVERLAP,
        )
        if not chunks:
            raise SystemExit(f"文档 {document['name']} 没有切出任何片段")
        vectors = await embeddings.embed([chunk.text for chunk in chunks])
        store.add_document(
            {
                "id": document["id"],
                "name": document["name"],
                "sha256": hashlib.sha256(content).hexdigest(),
                "size": len(content),
                "chunk_count": len(chunks),
                "created_at": "2026-01-01T00:00:00+00:00",
            },
            chunks,
            vectors,
            content,
        )
        for chunk in chunks:
            chunk_info[chunk.id] = (chunk.file_name, chunk.text)
    return store, chunk_info


async def evaluate_case(
    case: dict,
    store: LocalStore,
    embeddings,
    chat,
    chunk_info: dict,
    document_names: dict[str, str],
    threshold: float,
    require_terms: bool,
) -> dict:
    service = RAGService(store, embeddings, chat, threshold)
    calls_before = chat.calls
    started = time.perf_counter()
    result = await service.ask(case["question"], TOP_K)
    elapsed_ms = (time.perf_counter() - started) * 1000
    calls = chat.calls - calls_before

    hits = result["retrieval"]["hits"]
    retrieved = [hit["file_name"] for hit in hits]
    record = {
        "id": case["id"],
        "kind": case["kind"],
        "question": case["question"],
        "status": result["status"],
        "ms": round(elapsed_ms, 1),
        "model_calls": calls,
        "hits": [
            {"file_name": hit["file_name"], "score": round(hit["score"], 3)} for hit in hits
        ],
    }

    if case["kind"] == "answerable":
        expected = [document_names[item] for item in case["expected_documents"]]
        retrieval_hit = any(name in expected for name in retrieved)
        citations = result["citations"]
        citation_valid = bool(citations) and all(
            citation["chunk_id"] in chunk_info
            and chunk_info[citation["chunk_id"]][0] == citation["file_name"]
            and chunk_info[citation["chunk_id"]][1] == citation["text"]
            for citation in citations
        )
        citation_source = any(
            citation["file_name"] in expected for citation in citations
        )
        record["retrieval_hit"] = retrieval_hit
        record["answered"] = result["status"] == "answered"
        record["citation_valid"] = citation_valid and citation_source
        record["single_model_call"] = calls == 1
        passed = (
            retrieval_hit
            and record["answered"]
            and record["citation_valid"]
            and record["single_model_call"]
        )
        if require_terms:
            answer = normalize(result["answer"])
            record["terms_ok"] = all(
                normalize(term) in answer for term in case["expected_terms"]
            )
            passed = passed and record["terms_ok"]
        record["passed"] = passed
    else:
        refused = result["status"] == "no_answer"
        no_chat_without_evidence = calls == 0 if not hits else None
        record["refused"] = refused
        record["no_chat_without_evidence"] = no_chat_without_evidence
        record["passed"] = refused and (calls == 0 if not hits else True)

    return record


def ratio(values: list[bool]) -> float:
    return sum(1 for value in values if value) / len(values) if values else 0.0


def summarize(records: list[dict]) -> dict:
    answerable = [record for record in records if record["kind"] == "answerable"]
    unanswerable = [record for record in records if record["kind"] == "unanswerable"]
    answered = [record for record in answerable if record.get("answered")]
    empty_hits = [
        record for record in unanswerable if record["no_chat_without_evidence"] is not None
    ]
    durations = [record["ms"] for record in records]
    metrics = {
        "retrieval_recall": ratio([record["retrieval_hit"] for record in answerable]),
        "citation_validity": ratio([record["citation_valid"] for record in answered]),
        "refusal_rate": ratio([record["refused"] for record in unanswerable]),
        "no_evidence_no_chat": ratio(
            [record["no_chat_without_evidence"] for record in empty_hits]
        )
        if empty_hits
        else 1.0,
        "latency_ms": {
            "avg": round(statistics.fmean(durations), 1),
            "p50": round(statistics.median(durations), 1),
            "max": round(max(durations), 1),
        },
    }
    if any("terms_ok" in record for record in answerable):
        metrics["answer_terms"] = ratio([record["terms_ok"] for record in answerable])
    return metrics


def print_report(mode: str, dataset: dict, records: list[dict], metrics: dict) -> None:
    print(f"mode: {mode}")
    print(f"documents: {len(dataset['documents'])}  cases: {len(records)}")
    print()
    print(f"{'case':<24}{'kind':<14}{'status':<10}{'ms':>7}  hits")
    for record in records:
        hits = ", ".join(hit["file_name"] for hit in record["hits"])
        print(
            f"{record['id']:<24}{record['kind']:<14}{record['status']:<10}"
            f"{record['ms']:>7}  {hits}"
        )
    print()
    for name, value in metrics.items():
        if name == "latency_ms":
            print(f"latency: avg {value['avg']} ms, p50 {value['p50']} ms, max {value['max']} ms")
        else:
            print(f"{name}: {value:.3f}")
    failed = [record["id"] for record in records if not record["passed"]]
    if failed:
        print(f"failed cases: {', '.join(failed)}")


def gate(metrics: dict, mode: str, args) -> list[str]:
    failures = []
    if metrics["retrieval_recall"] < args.min_recall:
        failures.append(
            f"retrieval_recall {metrics['retrieval_recall']:.3f} < {args.min_recall}"
        )
    if metrics["citation_validity"] < args.min_citation:
        failures.append(
            f"citation_validity {metrics['citation_validity']:.3f} < {args.min_citation}"
        )
    if metrics["refusal_rate"] < args.min_refusal:
        failures.append(f"refusal_rate {metrics['refusal_rate']:.3f} < {args.min_refusal}")
    if metrics["no_evidence_no_chat"] < 1.0:
        failures.append("存在无检索证据仍调用模型的情况")
    if mode == "live" and "answer_terms" in metrics:
        if metrics["answer_terms"] < args.min_answer:
            failures.append(
                f"answer_terms {metrics['answer_terms']:.3f} < {args.min_answer}"
            )
    return failures


def live_providers(args):
    from dotenv import load_dotenv

    load_dotenv(ROOT / "backend" / ".env")
    silicon_key = os.environ.get("SILICONFLOW_API_KEY", "").strip()
    deepseek_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not silicon_key or not deepseek_key:
        raise SystemExit(
            "live 模式需要 SILICONFLOW_API_KEY 与 DEEPSEEK_API_KEY（环境变量或 backend/.env）"
        )

    from app.providers import DeepSeekChat, SiliconFlowEmbeddings

    embeddings = SiliconFlowEmbeddings(
        silicon_key,
        os.environ.get("SILICONFLOW_EMBEDDING_MODEL", "BAAI/bge-m3"),
    )
    chat = DeepSeekChat(
        deepseek_key,
        os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
    )
    return embeddings, CountingChat(chat)


async def run(args) -> int:
    dataset = load_dataset(args.dataset)
    threshold = args.threshold or THRESHOLD[args.mode]

    if args.mode == "live":
        embeddings, chat = live_providers(args)
    else:
        embeddings = HashedEmbeddings()

    data_dir = Path(tempfile.mkdtemp(prefix="findanswer-eval-"))
    document_names = {
        document["id"]: document["name"] for document in dataset["documents"]
    }
    try:
        store, chunk_info = await build_store(dataset, embeddings, data_dir)
        records = []
        for case in dataset["cases"]:
            if args.mode == "offline":
                chat = ScriptedChat(bool(case["expected_documents"]))
            record = await evaluate_case(
                case,
                store,
                embeddings,
                chat,
                chunk_info,
                document_names,
                threshold,
                require_terms=args.mode == "live",
            )
            records.append(record)
    finally:
        shutil.rmtree(data_dir, ignore_errors=True)

    metrics = summarize(records)
    print_report(args.mode, dataset, records, metrics)

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(
            json.dumps(
                {
                    "mode": args.mode,
                    "threshold": threshold,
                    "metrics": metrics,
                    "cases": records,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    failures = gate(metrics, args.mode, args)
    if failures:
        print()
        print("gate failed:")
        for failure in failures:
            print(f"- {failure}")
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="FindAnswer 评测运行器")
    parser.add_argument("--mode", choices=["offline", "live"], default="offline")
    parser.add_argument("--dataset", type=Path, default=ROOT / "eval" / "dataset.json")
    parser.add_argument("--threshold", type=float, default=None)
    parser.add_argument("--min-recall", type=float, default=0.8)
    parser.add_argument("--min-answer", type=float, default=0.8)
    parser.add_argument("--min-citation", type=float, default=0.8)
    parser.add_argument("--min-refusal", type=float, default=1.0)
    parser.add_argument("--report", type=Path, default=None)
    args = parser.parse_args()
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())