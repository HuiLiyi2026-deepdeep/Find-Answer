import sqlite3
import tempfile
from pathlib import Path

import pytest

from app.chunking import SourceChunk
from app.storage import LocalStore


@pytest.fixture
def data_dir(monkeypatch):
    monkeypatch.setenv("ANONYMIZED_TELEMETRY", "False")
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
        yield Path(directory)


def test_local_store_persists_and_deletes_sqlite_chroma_and_original(data_dir):
    document = {
        "id": "doc-real",
        "name": "real.txt",
        "sha256": "a" * 64,
        "size": 12,
        "chunk_count": 2,
        "created_at": "2026-10-30T12:00:00Z",
    }
    chunks = [
        SourceChunk("doc-real:0", "doc-real", "real.txt", None, 0, "alpha text"),
        SourceChunk("doc-real:1", "doc-real", "real.txt", None, 1, "beta text"),
    ]
    store = LocalStore(data_dir)

    store.add_document(document, chunks, [[1.0, 0.0], [0.0, 1.0]], b"real content")
    original = data_dir / "originals" / "doc-real.txt"
    assert original.read_bytes() == b"real content"

    reopened = LocalStore(data_dir)
    assert reopened.count_documents() == 1
    assert reopened.get_document("doc-real") == document
    assert [chunk["text"] for chunk in reopened.get_chunks("doc-real")] == [
        "alpha text",
        "beta text",
    ]
    hits = reopened.search([0.9, 0.1], top_k=1)
    assert len(hits) == 1
    assert hits[0]["id"] == "doc-real:0"
    assert hits[0]["score"] > 0.9

    assert reopened.delete_document("doc-real") is True
    assert reopened.count_documents() == 0
    assert reopened.collection.count() == 0
    assert not original.exists()


def add_test_document(store, data_dir):
    document = {
        "id": "doc-rollback",
        "name": "rollback.txt",
        "sha256": "b" * 64,
        "size": 15,
        "chunk_count": 2,
        "created_at": "2026-10-30T12:00:00Z",
    }
    chunks = [
        SourceChunk("doc-rollback:0", "doc-rollback", "rollback.txt", None, 0, "alpha"),
        SourceChunk("doc-rollback:1", "doc-rollback", "rollback.txt", None, 1, "beta"),
    ]
    store.add_document(
        document, chunks, [[1.0, 0.0], [0.0, 1.0]], b"rollback content"
    )
    return document, data_dir / "originals" / "doc-rollback.txt"


def assert_test_document_restored(store, document, original):
    assert store.get_document(document["id"]) == document
    assert [chunk["text"] for chunk in store.get_chunks(document["id"])] == [
        "alpha",
        "beta",
    ]
    result = store.collection.get(
        where={"document_id": document["id"]}, include=["embeddings"]
    )
    vectors = {
        chunk_id: [float(value) for value in embedding]
        for chunk_id, embedding in zip(result["ids"], result["embeddings"])
    }
    assert vectors == {
        "doc-rollback:0": [1.0, 0.0],
        "doc-rollback:1": [0.0, 1.0],
    }
    assert original.read_bytes() == b"rollback content"


def test_sqlite_delete_failure_rolls_back_chroma_and_preserves_document(
    data_dir, monkeypatch
):
    store = LocalStore(data_dir)
    document, original = add_test_document(store, data_dir)
    original_connect = store._connect

    class FailingConnection:
        def __init__(self, connection):
            self.connection = connection

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return self.connection.__exit__(*args)

        def execute(self, sql, *args, **kwargs):
            if sql.lstrip().upper().startswith("DELETE FROM DOCUMENTS"):
                raise sqlite3.OperationalError("injected SQLite failure")
            return self.connection.execute(sql, *args, **kwargs)

        def __getattr__(self, name):
            return getattr(self.connection, name)

    monkeypatch.setattr(
        store, "_connect", lambda: FailingConnection(original_connect())
    )

    with pytest.raises(sqlite3.OperationalError, match="injected SQLite failure"):
        store.delete_document(document["id"])

    assert_test_document_restored(store, document, original)


def test_original_file_delete_failure_rolls_back_sqlite_and_chroma(
    data_dir, monkeypatch
):
    store = LocalStore(data_dir)
    document, original = add_test_document(store, data_dir)
    original_unlink = Path.unlink

    def fail_original_unlink(path, *args, **kwargs):
        if path == original:
            raise PermissionError("injected original-file failure")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_original_unlink)

    with pytest.raises(PermissionError, match="injected original-file failure"):
        store.delete_document(document["id"])

    assert_test_document_restored(store, document, original)
