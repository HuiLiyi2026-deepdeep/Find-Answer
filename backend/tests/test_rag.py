import asyncio

import pytest

from app.rag import RAGService


class FakeEmbeddings:
    def __init__(self):
        self.calls = []

    async def embed(self, texts):
        self.calls.append(texts)
        return [[0.1, 0.2] for _ in texts]


class FakeChat:
    def __init__(self, response="答案 [1]。"):
        self.response = response
        self.calls = []

    async def complete(self, messages):
        self.calls.append(messages)
        return self.response


class FakeStore:
    def __init__(self, hits):
        self.hits = hits
        self.calls = []

    def search(self, embedding, top_k):
        self.calls.append((embedding, top_k))
        return self.hits


def hit(number, score=0.9):
    return {
        "id": f"doc:{number - 1}",
        "document_id": "doc",
        "file_name": f"资料{number}.md",
        "page": number,
        "chunk_index": number - 1,
        "text": f"第{number}段真实原文",
        "score": score,
    }


def run(service, question="问题"):
    return asyncio.run(service.ask(question, top_k=5))


def test_no_hits_returns_exact_refusal_without_calling_chat():
    chat = FakeChat()
    service = RAGService(FakeStore([]), FakeEmbeddings(), chat, score_threshold=0.5)

    result = run(service)

    assert result["status"] == "no_answer"
    assert result["answer"] == "你提供的资料中没有这个问题的答案。"
    assert result["citations"] == []
    assert result["retrieval"]["hits"] == []
    assert chat.calls == []


def test_low_score_hits_return_refusal_without_calling_chat():
    chat = FakeChat()
    service = RAGService(
        FakeStore([hit(1, score=0.2)]), FakeEmbeddings(), chat, score_threshold=0.5
    )

    result = run(service)

    assert result["status"] == "no_answer"
    assert result["answer"] == "你提供的资料中没有这个问题的答案。"
    assert result["retrieval"]["hits"] == []
    assert chat.calls == []


def test_insufficient_evidence_marker_is_mapped_to_refusal():
    chat = FakeChat("NO_ANSWER")
    service = RAGService(FakeStore([hit(1)]), FakeEmbeddings(), chat)

    result = run(service)

    assert result["status"] == "no_answer"
    assert result["answer"] == "根据你提供的资料，我无法回答这个问题。"
    assert result["citations"] == []
    assert len(result["retrieval"]["hits"]) == 1


def test_no_answer_embedded_in_otherwise_cited_answer_is_refused():
    chat = FakeChat("NO_ANSWER [1]")
    service = RAGService(FakeStore([hit(1)]), FakeEmbeddings(), chat)

    result = run(service)

    assert result["status"] == "no_answer"
    assert result["answer"] == "根据你提供的资料，我无法回答这个问题。"
    assert result["citations"] == []


@pytest.mark.parametrize(
    "response", ["真实答案 [1]，但引用越界 [2]。", "真实答案 【1】，但引用越界 【99】。"]
)
def test_mixed_valid_and_invalid_citations_refuse_entire_answer(response):
    chat = FakeChat(response)
    service = RAGService(FakeStore([hit(1)]), FakeEmbeddings(), chat)

    result = run(service)

    assert result["status"] == "no_answer"
    assert result["answer"] == "根据你提供的资料，我无法回答这个问题。"
    assert result["citations"] == []
    assert result["retrieval"]["hits"] == [hit(1)]


@pytest.mark.parametrize("response", ["这是没有引用的答案。", "越界引用 [99]。"])
def test_answer_without_valid_citation_is_refused_with_retrieval_evidence(response):
    chat = FakeChat(response)
    service = RAGService(FakeStore([hit(1)]), FakeEmbeddings(), chat)

    result = run(service)

    assert result["status"] == "no_answer"
    assert result["answer"] == "根据你提供的资料，我无法回答这个问题。"
    assert result["citations"] == []
    assert result["retrieval"]["hits"] == [hit(1)]


def test_answer_citations_map_only_to_real_numbered_chunks():
    chat = FakeChat("根据第二段作答 [2]。")
    store = FakeStore([hit(1), hit(2)])
    service = RAGService(store, FakeEmbeddings(), chat)

    result = run(service)

    assert result["status"] == "answered"
    assert result["answer"] == "根据第二段作答 [2]。"
    assert result["citations"] == [
        {
            "number": 2,
            "chunk_id": "doc:1",
            "document_id": "doc",
            "file_name": "资料2.md",
            "page": 2,
            "chunk_index": 1,
            "text": "第2段真实原文",
        }
    ]
    assert len(chat.calls) == 1
    prompt = chat.calls[0][-1]["content"]
    assert "[1] 第1段真实原文" in prompt
    assert "[2] 第2段真实原文" in prompt
    assert "NO_ANSWER" in chat.calls[0][0]["content"]
    assert store.calls == [([0.1, 0.2], 5)]
