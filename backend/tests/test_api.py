import sqlite3

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.providers import ProviderError


class FakeEmbeddings:
    def __init__(self, error=None):
        self.error = error
        self.calls = []
        self.api_key = ""

    async def embed(self, texts):
        self.calls.append(texts)
        if self.error:
            raise self.error
        return [[0.1, 0.2] for _ in texts]


class OrderedEmbeddings:
    def __init__(self):
        self.calls = []

    async def embed(self, texts):
        self.calls.append(texts)
        return [[float(ord(text))] for text in texts]


class FakeChat:
    def __init__(self, error=None):
        self.error = error
        self.calls = []
        self.api_key = ""

    async def complete(self, messages):
        self.calls.append(messages)
        if self.error:
            raise self.error
        return "NO_ANSWER"


class FakeCredentialStore:
    def __init__(self, values=None, error=None):
        self.values = values or {}
        self.error = error

    def get(self, provider):
        return self.values.get(provider)

    def set(self, provider, api_key):
        if self.error:
            raise self.error
        self.values[provider] = api_key


class FakeStore:
    def __init__(self):
        self.documents = []
        self.chunks = []
        self.hits = []
        self.saved_content = {}
        self.saved_embeddings = {}

    def count_documents(self):
        return len(self.documents)

    def count_chunks(self):
        return sum(document["chunk_count"] for document in self.documents)

    def list_documents(self):
        return self.documents

    def get_document(self, document_id):
        return next((doc for doc in self.documents if doc["id"] == document_id), None)

    def find_by_hash(self, sha256):
        return next((doc for doc in self.documents if doc["sha256"] == sha256), None)

    def add_document(self, document, chunks, embeddings, content):
        self.documents.append(document)
        self.chunks.extend(chunk.to_dict() for chunk in chunks)
        self.saved_content[document["id"]] = content
        self.saved_embeddings[document["id"]] = embeddings

    def get_chunks(self, document_id):
        return [chunk for chunk in self.chunks if chunk["document_id"] == document_id]

    def search(self, embedding, top_k):
        return self.hits[:top_k]

    def delete_document(self, document_id):
        document = self.get_document(document_id)
        if not document:
            return False
        self.documents.remove(document)
        self.chunks = [
            chunk for chunk in self.chunks if chunk["document_id"] != document_id
        ]
        self.saved_content.pop(document_id, None)
        self.saved_embeddings.pop(document_id, None)
        return True


class RacingDuplicateStore(FakeStore):
    def add_document(self, document, chunks, embeddings, content):
        raise sqlite3.IntegrityError("UNIQUE constraint failed: documents.sha256")


class FailingDeleteStore(FakeStore):
    def __init__(self, error):
        super().__init__()
        self.error = error

    def delete_document(self, document_id):
        raise self.error


def make_pdf(page_texts):
    font_number = 3 + 2 * len(page_texts)
    page_numbers = [3 + 2 * index for index in range(len(page_texts))]
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: (
            f"<< /Type /Pages /Kids [{' '.join(f'{number} 0 R' for number in page_numbers)}] "
            f"/Count {len(page_texts)} >>"
        ).encode(),
        font_number: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    for page_number, text in zip(page_numbers, page_texts):
        content_number = page_number + 1
        objects[page_number] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 {font_number} 0 R >> >> "
            f"/Contents {content_number} 0 R >>"
        ).encode()
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode()
        objects[content_number] = (
            f"<< /Length {len(stream)} >>\nstream\n".encode()
            + stream
            + b"\nendstream"
        )

    output = bytearray(b"%PDF-1.4\n")
    offsets = [0] * (font_number + 1)
    for number in range(1, font_number + 1):
        offsets[number] = len(output)
        output.extend(f"{number} 0 obj\n".encode())
        output.extend(objects[number])
        output.extend(b"\nendobj\n")
    xref_offset = len(output)
    output.extend(f"xref\n0 {font_number + 1}\n".encode())
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode())
    output.extend(
        f"trailer\n<< /Size {font_number + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n".encode()
    )
    return bytes(output)


def make_client(
    tmp_path,
    embeddings=None,
    chat=None,
    store=None,
    credentials=None,
    chunk_size=600,
    chunk_overlap=80,
    siliconflow_api_key="",
    deepseek_api_key="",
):
    settings = Settings(
        data_dir=tmp_path,
        siliconflow_api_key=siliconflow_api_key,
        deepseek_api_key=deepseek_api_key,
        embedding_model="test-embedding",
        chat_model="test-chat",
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
    )
    store = store or FakeStore()
    app = create_app(
        settings=settings,
        store=store,
        embedding_provider=embeddings or FakeEmbeddings(),
        chat_provider=chat or FakeChat(),
        credential_store=credentials or FakeCredentialStore(),
    )
    return TestClient(app), store


def test_health_reports_configuration_without_secrets(tmp_path):
    client, _ = make_client(tmp_path)

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "mode": "local",
        "capabilities": {
            "upload": True,
            "delete": True,
            "manage_connections": True,
        },
        "upload_blocked_reason": None,
        "trusted_ip": True,
        "siliconflow_configured": False,
        "deepseek_configured": False,
        "models": {"embeddings": "test-embedding", "chat": "test-chat"},
        "document_count": 0,
        "quota": {
            "scope": "local",
            "documents_used": 0,
            "documents_limit": None,
            "chunks_used": 0,
            "chunks_limit": None,
            "daily_uploads_used": None,
            "daily_upload_limit": None,
            "daily_uploads_remaining": None,
        },
    }
    assert "key" not in response.text.lower()


def test_saved_credentials_configure_connections_without_exposing_secrets(tmp_path):
    credentials = FakeCredentialStore(
        {"siliconflow": "sk-stored-siliconflow", "deepseek": "sk-stored-deepseek"}
    )

    client, _ = make_client(tmp_path, credentials=credentials)
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["siliconflow_configured"] is True
    assert response.json()["deepseek_configured"] is True
    assert "sk-stored-siliconflow" not in response.text
    assert "sk-stored-deepseek" not in response.text


def test_siliconflow_key_is_tested_saved_and_activated_without_restart(tmp_path):
    credentials = FakeCredentialStore()
    embeddings = FakeEmbeddings()
    client, _ = make_client(
        tmp_path, embeddings=embeddings, credentials=credentials
    )

    response = client.put(
        "/api/connections/siliconflow", json={"api_key": "  sk-new-siliconflow  "}
    )

    assert response.status_code == 200
    assert response.json() == {
        "provider": "siliconflow",
        "configured": True,
        "model": "test-embedding",
    }
    assert credentials.values == {"siliconflow": "sk-new-siliconflow"}
    assert embeddings.api_key == "sk-new-siliconflow"
    assert embeddings.calls == [["FindAnswer connection test"]]
    assert client.get("/api/health").json()["siliconflow_configured"] is True
    assert "sk-new-siliconflow" not in response.text


def test_deepseek_key_is_tested_saved_and_activated_without_restart(tmp_path):
    credentials = FakeCredentialStore()
    chat = FakeChat()
    client, _ = make_client(tmp_path, chat=chat, credentials=credentials)

    response = client.put(
        "/api/connections/deepseek", json={"api_key": "sk-new-deepseek"}
    )

    assert response.status_code == 200
    assert response.json() == {
        "provider": "deepseek",
        "configured": True,
        "model": "test-chat",
    }
    assert credentials.values == {"deepseek": "sk-new-deepseek"}
    assert chat.api_key == "sk-new-deepseek"
    assert len(chat.calls) == 1
    assert client.get("/api/health").json()["deepseek_configured"] is True
    assert "sk-new-deepseek" not in response.text


def test_failed_connection_test_preserves_current_key_and_saves_nothing(tmp_path):
    credentials = FakeCredentialStore()
    embeddings = FakeEmbeddings(ProviderError("upstream exposed sk-new-siliconflow"))
    client, _ = make_client(
        tmp_path,
        embeddings=embeddings,
        credentials=credentials,
        siliconflow_api_key="sk-current-siliconflow",
    )

    response = client.put(
        "/api/connections/siliconflow", json={"api_key": "sk-new-siliconflow"}
    )

    assert response.status_code == 502
    assert response.json() == {"detail": "硅基流动连接测试失败，请检查密钥后重试。"}
    assert credentials.values == {}
    assert embeddings.api_key == "sk-current-siliconflow"
    assert client.get("/api/health").json()["siliconflow_configured"] is True
    assert "sk-new-siliconflow" not in response.text


def test_credential_storage_failure_does_not_activate_new_key(tmp_path):
    credentials = FakeCredentialStore(error=RuntimeError("credential path sk-secret"))
    chat = FakeChat()
    client, _ = make_client(
        tmp_path,
        chat=chat,
        credentials=credentials,
        deepseek_api_key="sk-current-deepseek",
    )

    response = client.put(
        "/api/connections/deepseek", json={"api_key": "sk-new-deepseek"}
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "无法保存到 Windows 凭据管理器，请稍后重试。"}
    assert chat.api_key == "sk-current-deepseek"
    assert client.get("/api/health").json()["deepseek_configured"] is True
    assert "sk-new-deepseek" not in response.text
    assert "credential path" not in response.text


def test_blank_or_unknown_connections_do_not_call_providers_or_storage(tmp_path):
    credentials = FakeCredentialStore()
    embeddings = FakeEmbeddings()
    client, _ = make_client(
        tmp_path, embeddings=embeddings, credentials=credentials
    )

    blank = client.put("/api/connections/siliconflow", json={"api_key": " \n"})
    unknown = client.put("/api/connections/other", json={"api_key": "sk-new"})

    assert blank.status_code == 422
    assert unknown.status_code == 404
    assert embeddings.calls == []
    assert credentials.values == {}


def test_blank_questions_are_rejected_before_embedding(tmp_path):
    embeddings = FakeEmbeddings()
    client, _ = make_client(tmp_path, embeddings=embeddings)

    search = client.post("/api/search", json={"question": "  \n"})
    ask = client.post("/api/ask", json={"question": "\t"})

    assert search.status_code == 422
    assert ask.status_code == 422
    assert embeddings.calls == []


def test_ask_returns_no_answer_when_retrieval_has_no_hits(tmp_path):
    client, _ = make_client(tmp_path)

    response = client.post("/api/ask", json={"question": "没有资料的问题"})

    assert response.status_code == 200
    assert response.json()["status"] == "no_answer"
    assert response.json()["answer"] == "你提供的资料中没有这个问题的答案。"


def test_upload_returns_completed_document_and_supports_listing_chunks(tmp_path):
    client, store = make_client(tmp_path)

    response = client.post(
        "/api/documents",
        files={"file": ("笔记.md", "第一段。\n\n第二段。".encode(), "text/markdown")},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["name"] == "笔记.md"
    assert document["chunk_count"] == 1
    assert len(document["sha256"]) == 64
    assert store.saved_content[document["id"]] == "第一段。\n\n第二段。".encode()

    listed = client.get("/api/documents")
    chunks = client.get(f"/api/documents/{document['id']}/chunks")
    deleted = client.delete(f"/api/documents/{document['id']}")

    assert listed.json() == {"documents": [document]}
    assert chunks.status_code == 200
    assert chunks.json()["chunks"][0]["text"] == "第一段。\n\n第二段。"
    assert deleted.status_code == 204
    assert client.get("/api/documents").json() == {"documents": []}


def test_invalid_empty_and_duplicate_uploads_have_clear_errors(tmp_path):
    client, _ = make_client(tmp_path)

    unsupported = client.post(
        "/api/documents", files={"file": ("bad.exe", b"text", "application/octet-stream")}
    )
    empty = client.post(
        "/api/documents", files={"file": ("empty.txt", b"", "text/plain")}
    )
    first = client.post(
        "/api/documents", files={"file": ("one.txt", b"same", "text/plain")}
    )
    duplicate = client.post(
        "/api/documents", files={"file": ("two.txt", b"same", "text/plain")}
    )

    assert unsupported.status_code == 400
    assert empty.status_code == 400
    assert first.status_code == 201
    assert duplicate.status_code == 409


def test_duplicate_integrity_error_returns_409(tmp_path):
    client, _ = make_client(tmp_path, store=RacingDuplicateStore())

    response = client.post(
        "/api/documents", files={"file": ("race.txt", b"same", "text/plain")}
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "该文件已上传，请勿重复上传。"}


def test_upload_embeddings_are_batched_without_changing_chunk_alignment(tmp_path):
    embeddings = OrderedEmbeddings()
    client, store = make_client(
        tmp_path, embeddings=embeddings, chunk_size=1, chunk_overlap=0
    )
    text = "".join(chr(33 + index) for index in range(70))

    response = client.post(
        "/api/documents", files={"file": ("batches.txt", text.encode(), "text/plain")}
    )

    assert response.status_code == 201
    document = response.json()
    assert [len(call) for call in embeddings.calls] == [32, 32, 6]
    assert [text for call in embeddings.calls for text in call] == list(text)
    assert store.saved_embeddings[document["id"]] == [
        [float(ord(character))] for character in text
    ]


def test_textual_pdf_upload_preserves_page_metadata(tmp_path):
    client, store = make_client(tmp_path)

    response = client.post(
        "/api/documents",
        files={
            "file": (
                "pages.pdf",
                make_pdf(["First page", "Second page"]),
                "application/pdf",
            )
        },
    )

    assert response.status_code == 201
    document = response.json()
    chunks = store.chunks
    assert document["chunk_count"] == 2
    assert [chunk["page"] for chunk in chunks] == [1, 2]
    assert "First page" in chunks[0]["text"]
    assert "Second page" in chunks[1]["text"]


def test_upload_accepts_exactly_20_mib_and_rejects_one_byte_more(tmp_path):
    maximum = 20 * 1024 * 1024
    client, _ = make_client(tmp_path, chunk_size=maximum, chunk_overlap=0)

    accepted = client.post(
        "/api/documents",
        files={"file": ("maximum.txt", b"a" * maximum, "text/plain")},
    )
    rejected = client.post(
        "/api/documents",
        files={"file": ("oversize.txt", b"a" * (maximum + 1), "text/plain")},
    )

    assert accepted.status_code == 201
    assert accepted.json()["size"] == maximum
    assert rejected.status_code == 413


def test_provider_failures_are_sanitized_502_responses(tmp_path):
    embeddings = FakeEmbeddings(ProviderError("upstream exposed sk-secret"))
    client, _ = make_client(tmp_path, embeddings=embeddings)

    response = client.post("/api/search", json={"question": "问题"})

    assert response.status_code == 502
    assert "sk-secret" not in response.text
    assert "Embedding" in response.json()["detail"]


def test_delete_storage_failure_is_sanitized_500(tmp_path):
    store = FailingDeleteStore(RuntimeError("storage path and sk-secret"))
    client, _ = make_client(tmp_path, store=store)

    response = client.delete("/api/documents/doc-real")

    assert response.status_code == 500
    assert response.json() == {"detail": "删除资料失败，请稍后重试。"}
    assert "sk-secret" not in response.text
    assert "storage path" not in response.text


def test_delete_integrity_conflict_is_sanitized_409(tmp_path):
    store = FailingDeleteStore(sqlite3.IntegrityError("database is locked: secret"))
    client, _ = make_client(tmp_path, store=store)

    response = client.delete("/api/documents/doc-real")

    assert response.status_code == 409
    assert response.json() == {"detail": "资料删除与当前状态冲突，请刷新后重试。"}
    assert "secret" not in response.text


def test_batch_id_enforces_100_eligible_uploads(tmp_path):
    client, _ = make_client(tmp_path)
    responses = []
    for index in range(101):
        responses.append(client.post(
            "/api/documents",
            data={"batch_id": "batch-limit"},
            files={"file": (f"{index}.txt", b"same", "text/plain")},
        ))

    assert responses[0].status_code == 201
    assert all(response.status_code == 409 for response in responses[1:100])
    assert responses[100].status_code == 400
    assert responses[100].json() == {"detail": "每批最多上传 100 个合格文件。"}
