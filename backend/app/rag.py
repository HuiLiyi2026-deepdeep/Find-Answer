import re


NO_RETRIEVAL_ANSWER = "你提供的资料中没有这个问题的答案。"
INSUFFICIENT_EVIDENCE_ANSWER = "根据你提供的资料，我无法回答这个问题。"


class RAGService:
    def __init__(self, store, embeddings, chat, score_threshold: float = 0.25) -> None:
        self.store = store
        self.embeddings = embeddings
        self.chat = chat
        self.score_threshold = score_threshold

    async def retrieve(self, question: str, top_k: int) -> dict:
        vectors = await self.embeddings.embed([question.strip()])
        hits = self.store.search(vectors[0], top_k)
        hits = [hit for hit in hits if hit["score"] >= self.score_threshold]
        return {
            "question": question.strip(),
            "top_k": top_k,
            "score_threshold": self.score_threshold,
            "hits": hits,
            "count": len(hits),
        }

    async def ask(self, question: str, top_k: int = 5) -> dict:
        retrieval = await self.retrieve(question, top_k)
        evidence = retrieval["hits"]
        if not evidence:
            return {
                "status": "no_answer",
                "answer": NO_RETRIEVAL_ANSWER,
                "citations": [],
                "retrieval": retrieval,
            }

        numbered = "\n\n".join(
            f"[{number}] {chunk['text']}" for number, chunk in enumerate(evidence, 1)
        )
        messages = [
            {
                "role": "system",
                "content": (
                    "你是严格的资料问答助手。只能根据用户提供的编号资料片段回答，"
                    "不得使用常识或资料之外的信息。回答时使用资料编号标注引用，"
                    "格式为 [1]、[2]。如果资料不足以回答，只输出 NO_ANSWER，"
                    "不要输出任何其他内容。"
                ),
            },
            {
                "role": "user",
                "content": f"问题：{question.strip()}\n\n编号资料片段：\n{numbered}",
            },
        ]
        answer = (await self.chat.complete(messages)).strip()
        if "NO_ANSWER" in answer:
            return {
                "status": "no_answer",
                "answer": INSUFFICIENT_EVIDENCE_ANSWER,
                "citations": [],
                "retrieval": retrieval,
            }

        cited_numbers = []
        for match in re.finditer(r"\[(\d+)\]|【(\d+)】", answer):
            number = int(match.group(1) or match.group(2))
            if not 1 <= number <= len(evidence):
                return {
                    "status": "no_answer",
                    "answer": INSUFFICIENT_EVIDENCE_ANSWER,
                    "citations": [],
                    "retrieval": retrieval,
                }
            if number not in cited_numbers:
                cited_numbers.append(number)

        if not cited_numbers:
            return {
                "status": "no_answer",
                "answer": INSUFFICIENT_EVIDENCE_ANSWER,
                "citations": [],
                "retrieval": retrieval,
            }

        citations = []
        for number in cited_numbers:
            chunk = evidence[number - 1]
            citations.append(
                {
                    "number": number,
                    "chunk_id": chunk["id"],
                    "document_id": chunk["document_id"],
                    "file_name": chunk["file_name"],
                    "page": chunk["page"],
                    "chunk_index": chunk["chunk_index"],
                    "text": chunk["text"],
                }
            )
        return {
            "status": "answered",
            "answer": answer,
            "citations": citations,
            "retrieval": retrieval,
        }
