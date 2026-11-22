from math import isfinite
from typing import Any

import httpx


class ProviderError(RuntimeError):
    """A sanitized upstream provider failure."""


class SiliconFlowEmbeddings:
    def __init__(self, api_key: str, model: str = "BAAI/bge-m3") -> None:
        self.api_key = api_key
        self.model = model

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not self.api_key:
            raise ProviderError("SiliconFlow API key is not configured")
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                response = await client.post(
                    "https://api.siliconflow.cn/v1/embeddings",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json={"model": self.model, "input": texts},
                )
                response.raise_for_status()
                payload: dict[str, Any] = response.json()
                rows = sorted(payload["data"], key=lambda row: row["index"])
                indices = [row["index"] for row in rows]
                embeddings = [row["embedding"] for row in rows]
                if (
                    len(embeddings) != len(texts)
                    or any(
                        not isinstance(index, int) or isinstance(index, bool)
                        for index in indices
                    )
                    or indices != list(range(len(texts)))
                    or any(
                        not isinstance(vector, list) or not vector
                        for vector in embeddings
                    )
                    or len({len(vector) for vector in embeddings}) > 1
                    or any(
                        isinstance(value, bool)
                        or not isinstance(value, (int, float))
                        or (isinstance(value, float) and not isfinite(value))
                        for vector in embeddings
                        for value in vector
                    )
                ):
                    raise ValueError("invalid embedding response")
                return embeddings
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            raise ProviderError("Embedding provider request failed") from exc


class DeepSeekChat:
    def __init__(self, api_key: str, model: str = "deepseek-chat") -> None:
        self.api_key = api_key
        self.model = model

    async def complete(self, messages: list[dict[str, str]]) -> str:
        if not self.api_key:
            raise ProviderError("DeepSeek API key is not configured")
        try:
            async with httpx.AsyncClient(timeout=90) as client:
                response = await client.post(
                    "https://api.deepseek.com/chat/completions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json={
                        "model": self.model,
                        "messages": messages,
                        "temperature": 0,
                        "stream": False,
                    },
                )
                response.raise_for_status()
                content = response.json()["choices"][0]["message"]["content"]
                if not isinstance(content, str) or not content.strip():
                    raise ValueError("empty chat response")
                return content.strip()
        except (httpx.HTTPError, KeyError, IndexError, TypeError, ValueError) as exc:
            raise ProviderError("Chat provider request failed") from exc
