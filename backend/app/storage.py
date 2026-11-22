import sqlite3
from pathlib import Path

import chromadb

from .chunking import SourceChunk


class LocalStore:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = Path(data_dir)
        self.originals_dir = self.data_dir / "originals"
        self.originals_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.data_dir / "findanswer.db"
        self._initialize_database()
        client = chromadb.PersistentClient(path=str(self.data_dir / "chroma"))
        self.collection = client.get_or_create_collection(
            name="documents", metadata={"hnsw:space": "cosine"}
        )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize_database(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    sha256 TEXT NOT NULL UNIQUE,
                    size INTEGER NOT NULL,
                    chunk_count INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )

    @staticmethod
    def _document(row: sqlite3.Row | None) -> dict | None:
        return dict(row) if row is not None else None

    def count_documents(self) -> int:
        with self._connect() as connection:
            return connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0]

    def count_chunks(self) -> int:
        return self.collection.count()

    def list_documents(self) -> list[dict]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM documents ORDER BY created_at DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def get_document(self, document_id: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
        return self._document(row)

    def find_by_hash(self, sha256: str) -> dict | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM documents WHERE sha256 = ?", (sha256,)
            ).fetchone()
        return self._document(row)

    def add_document(
        self,
        document: dict,
        chunks: list[SourceChunk],
        embeddings: list[list[float]],
        content: bytes,
    ) -> None:
        if len(chunks) != len(embeddings):
            raise ValueError("Every chunk must have one embedding")
        extension = Path(document["name"]).suffix.lower()
        original_path = self.originals_dir / f"{document['id']}{extension}"
        original_path.write_bytes(content)
        connection = self._connect()
        try:
            connection.execute(
                """
                INSERT INTO documents (id, name, sha256, size, chunk_count, created_at)
                VALUES (:id, :name, :sha256, :size, :chunk_count, :created_at)
                """,
                document,
            )
            metadata = []
            for chunk in chunks:
                item = {
                    "document_id": chunk.document_id,
                    "file_name": chunk.file_name,
                    "chunk_index": chunk.chunk_index,
                }
                if chunk.page is not None:
                    item["page"] = chunk.page
                metadata.append(item)
            self.collection.add(
                ids=[chunk.id for chunk in chunks],
                embeddings=embeddings,
                documents=[chunk.text for chunk in chunks],
                metadatas=metadata,
            )
            connection.commit()
        except Exception:
            connection.rollback()
            self.collection.delete(ids=[chunk.id for chunk in chunks])
            original_path.unlink(missing_ok=True)
            raise
        finally:
            connection.close()

    @staticmethod
    def _chunk(chunk_id: str, text: str, metadata: dict) -> dict:
        return {
            "id": chunk_id,
            "document_id": metadata["document_id"],
            "file_name": metadata["file_name"],
            "page": metadata.get("page"),
            "chunk_index": metadata["chunk_index"],
            "text": text,
        }

    def get_chunks(self, document_id: str) -> list[dict]:
        result = self.collection.get(
            where={"document_id": document_id}, include=["documents", "metadatas"]
        )
        chunks = [
            self._chunk(chunk_id, text, metadata)
            for chunk_id, text, metadata in zip(
                result["ids"], result["documents"], result["metadatas"]
            )
        ]
        return sorted(chunks, key=lambda chunk: chunk["chunk_index"])

    def search(self, embedding: list[float], top_k: int) -> list[dict]:
        available = self.collection.count()
        if not available:
            return []
        result = self.collection.query(
            query_embeddings=[embedding],
            n_results=min(top_k, available),
            include=["documents", "metadatas", "distances"],
        )
        hits = []
        for chunk_id, text, metadata, distance in zip(
            result["ids"][0],
            result["documents"][0],
            result["metadatas"][0],
            result["distances"][0],
        ):
            chunk = self._chunk(chunk_id, text, metadata)
            chunk["score"] = 1.0 - float(distance)
            hits.append(chunk)
        return sorted(hits, key=lambda hit: hit["score"], reverse=True)

    def delete_document(self, document_id: str) -> bool:
        document = self.get_document(document_id)
        if not document:
            return False

        snapshot = self.collection.get(
            where={"document_id": document_id},
            include=["documents", "metadatas", "embeddings"],
        )
        originals = [
            (path, path.read_bytes())
            for path in self.originals_dir.glob(f"{document_id}.*")
        ]

        try:
            self.collection.delete(where={"document_id": document_id})
            with self._connect() as connection:
                connection.execute("DELETE FROM documents WHERE id = ?", (document_id,))
            for path, _ in originals:
                path.unlink(missing_ok=True)
        except Exception as deletion_error:
            # Chroma, SQLite and files are not transactional together. Restore each
            # snapshot independently, and surface an error if compensation fails.
            rollback_errors = []
            try:
                self.collection.delete(where={"document_id": document_id})
                if snapshot["ids"]:
                    self.collection.add(
                        ids=snapshot["ids"],
                        embeddings=snapshot["embeddings"],
                        documents=snapshot["documents"],
                        metadatas=snapshot["metadatas"],
                    )
            except Exception as rollback_error:
                rollback_errors.append(rollback_error)

            try:
                with self._connect() as connection:
                    connection.execute(
                        """
                        INSERT OR IGNORE INTO documents
                            (id, name, sha256, size, chunk_count, created_at)
                        VALUES (:id, :name, :sha256, :size, :chunk_count, :created_at)
                        """,
                        document,
                    )
            except Exception as rollback_error:
                rollback_errors.append(rollback_error)

            for path, content in originals:
                try:
                    path.write_bytes(content)
                except Exception as rollback_error:
                    rollback_errors.append(rollback_error)

            if rollback_errors:
                for rollback_error in rollback_errors:
                    deletion_error.add_note(f"Rollback failed: {rollback_error}")
                raise RuntimeError(
                    "Document deletion failed and rollback was incomplete"
                ) from deletion_error
            raise
        return True
