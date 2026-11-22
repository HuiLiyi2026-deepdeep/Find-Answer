import asyncio

import httpx
import pytest

from app.providers import ProviderError, SiliconFlowEmbeddings


def provider_returning(monkeypatch, payload):
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json=payload)
    )
    real_async_client = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        return real_async_client(*args, transport=transport, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client_factory)
    return SiliconFlowEmbeddings("offline-test-key")


@pytest.mark.parametrize(
    "payload",
    [
        {"data": [{"index": 1, "embedding": [0.1]}]},
        {
            "data": [
                {"index": 0, "embedding": [0.1]},
                {"index": 0, "embedding": [0.2]},
            ]
        },
        {
            "data": [
                {"index": 0, "embedding": [0.1, 0.2]},
                {"index": 1, "embedding": [0.3]},
            ]
        },
        {"data": [{"index": 0, "embedding": []}]},
        {"data": [{"index": 0, "embedding": [True]}]},
        {"data": [{"index": 0, "embedding": [float("nan")]}]},
        {"data": [{"index": 0, "embedding": [float("inf")]}]},
        {"data": [{"index": 0, "embedding": ["0.1"]}]},
    ],
    ids=[
        "missing-zero-index",
        "duplicate-index",
        "inconsistent-dimensions",
        "zero-dimensions",
        "boolean-element",
        "nan-element",
        "infinite-element",
        "string-element",
    ],
)
def test_malformed_embedding_responses_raise_sanitized_provider_error(
    monkeypatch, payload
):
    provider = provider_returning(monkeypatch, payload)

    with pytest.raises(ProviderError, match="^Embedding provider request failed$"):
        asyncio.run(provider.embed(["text"] * len(payload["data"])))


def test_valid_out_of_order_embeddings_are_sorted_and_allow_numbers(monkeypatch):
    provider = provider_returning(
        monkeypatch,
        {
            "data": [
                {"index": 1, "embedding": [1, 0.25]},
                {"index": 0, "embedding": [0.5, 0.75]},
            ]
        },
    )

    result = asyncio.run(provider.embed(["first", "second"]))

    assert result == [[0.5, 0.75], [1, 0.25]]
