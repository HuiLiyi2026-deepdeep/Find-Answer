import copy
import hashlib
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from .chunking import chunk_pages, extract_text
from .config import Settings
from .credentials import WindowsCredentialStore
from .providers import DeepSeekChat, ProviderError, SiliconFlowEmbeddings
from .rag import RAGService
from .storage import LocalStore


class QuestionRequest(BaseModel):
    question: str
    top_k: int | None = Field(default=None, ge=1, le=50)

    @field_validator("question")
    @classmethod
    def question_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("question must not be blank")
        return value


class ConnectionRequest(BaseModel):
    api_key: str

    @field_validator("api_key")
    @classmethod
    def api_key_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("api_key must not be blank")
        return value


def create_app(
    *,
    settings: Settings | None = None,
    store=None,
    embedding_provider=None,
    chat_provider=None,
    credential_store=None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    credential_store = credential_store or WindowsCredentialStore()
    if not settings.siliconflow_api_key:
        settings.siliconflow_api_key = (
            credential_store.get("siliconflow") or ""
        ).strip()
    if not settings.deepseek_api_key:
        settings.deepseek_api_key = (credential_store.get("deepseek") or "").strip()
    store = store if store is not None else LocalStore(settings.data_dir)
    embedding_provider = (
        embedding_provider
        if embedding_provider is not None
        else SiliconFlowEmbeddings(settings.siliconflow_api_key, settings.embedding_model)
    )
    chat_provider = (
        chat_provider
        if chat_provider is not None
        else DeepSeekChat(settings.deepseek_api_key, settings.chat_model)
    )
    if settings.siliconflow_api_key:
        embedding_provider.api_key = settings.siliconflow_api_key
    if settings.deepseek_api_key:
        chat_provider.api_key = settings.deepseek_api_key
    rag = RAGService(
        store, embedding_provider, chat_provider, settings.score_threshold
    )
    batch_counts: dict[str, int] = {}

    app = FastAPI(title="FindAnswer API", version="1.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://localhost:5174",
            "http://127.0.0.1:5173",
            "http://127.0.0.1:5174",
        ],
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    def top_k(request: QuestionRequest) -> int:
        return request.top_k if request.top_k is not None else settings.default_top_k

    @app.get("/api/health")
    def health() -> dict:
        documents = store.count_documents()
        chunks = store.count_chunks()
        return {
            "status": "ok",
            "mode": "local",
            "capabilities": {
                "upload": True,
                "delete": True,
                "manage_connections": True,
            },
            "upload_blocked_reason": None,
            "trusted_ip": True,
            "siliconflow_configured": bool(settings.siliconflow_api_key),
            "deepseek_configured": bool(settings.deepseek_api_key),
            "models": {
                "embeddings": settings.embedding_model,
                "chat": settings.chat_model,
            },
            "document_count": documents,
            "quota": {
                "scope": "local",
                "documents_used": documents,
                "documents_limit": None,
                "chunks_used": chunks,
                "chunks_limit": None,
                "daily_uploads_used": None,
                "daily_upload_limit": None,
                "daily_uploads_remaining": None,
            },
        }

    @app.put("/api/connections/{provider}")
    async def update_connection(provider: str, request: ConnectionRequest) -> dict:
        if provider not in {"siliconflow", "deepseek"}:
            raise HTTPException(404, "未知的模型提供方。")

        is_siliconflow = provider == "siliconflow"
        current_provider = embedding_provider if is_siliconflow else chat_provider
        model = settings.embedding_model if is_siliconflow else settings.chat_model
        probe = copy.copy(current_provider)
        probe.api_key = request.api_key
        try:
            if is_siliconflow:
                await probe.embed(["FindAnswer connection test"])
            else:
                await probe.complete(
                    [
                        {"role": "system", "content": "Reply with OK only."},
                        {"role": "user", "content": "Connection test"},
                    ]
                )
        except ProviderError as exc:
            provider_name = "硅基流动" if is_siliconflow else "DeepSeek"
            raise HTTPException(
                502, f"{provider_name}连接测试失败，请检查密钥后重试。"
            ) from exc

        try:
            credential_store.set(provider, request.api_key)
        except Exception as exc:
            raise HTTPException(
                500, "无法保存到 Windows 凭据管理器，请稍后重试。"
            ) from exc

        if is_siliconflow:
            settings.siliconflow_api_key = request.api_key
        else:
            settings.deepseek_api_key = request.api_key
        current_provider.api_key = request.api_key
        return {"provider": provider, "configured": True, "model": model}

    @app.get("/api/documents")
    def list_documents() -> dict:
        return {"documents": store.list_documents()}

    @app.post("/api/documents", status_code=201)
    async def upload_document(
        file: UploadFile = File(...),
        batch_id: str | None = Form(None),
    ) -> dict:
        name = (file.filename or "").replace("\\", "/").split("/")[-1].strip()
        if not name or Path(name).suffix.lower() not in {
            ".txt",
            ".md",
            ".markdown",
            ".pdf",
        }:
            raise HTTPException(400, "仅支持 TXT、Markdown 和文字型 PDF 文件。")
        content = await file.read(settings.max_file_size + 1)
        await file.close()
        if not content:
            raise HTTPException(400, "文件不能为空。")
        if len(content) > settings.max_file_size:
            raise HTTPException(413, "文件大小不能超过 20 MB。")
        if batch_id is not None:
            if not 1 <= len(batch_id) <= 128:
                raise HTTPException(400, "批次标识无效。")
            count = batch_counts.get(batch_id, 0) + 1
            if count > 100:
                raise HTTPException(400, "每批最多上传 100 个合格文件。")
            batch_counts[batch_id] = count
        sha256 = hashlib.sha256(content).hexdigest()
        if store.find_by_hash(sha256):
            raise HTTPException(409, "该文件已上传，请勿重复上传。")

        try:
            pages = extract_text(name, content)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        document_id = uuid.uuid4().hex
        chunks = chunk_pages(
            document_id,
            name,
            pages,
            chunk_size=settings.chunk_size,
            overlap=settings.chunk_overlap,
        )
        if not chunks:
            raise HTTPException(400, "文件没有可提取的文本内容。")

        texts = [chunk.text for chunk in chunks]
        embeddings = []
        try:
            for start in range(0, len(texts), 32):
                batch = texts[start : start + 32]
                batch_embeddings = await embedding_provider.embed(batch)
                if len(batch_embeddings) != len(batch):
                    raise ProviderError("Embedding provider returned incomplete results")
                embeddings.extend(batch_embeddings)
            if len(embeddings) != len(chunks):
                raise ProviderError("Embedding provider returned incomplete results")
        except ProviderError as exc:
            raise HTTPException(
                502, "上游 Embedding 服务请求失败，请稍后重试。"
            ) from exc

        document = {
            "id": document_id,
            "name": name,
            "sha256": sha256,
            "size": len(content),
            "chunk_count": len(chunks),
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        try:
            store.add_document(document, chunks, embeddings, content)
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "该文件已上传，请勿重复上传。") from exc
        return document

    @app.get("/api/documents/{document_id}/chunks")
    def get_document_chunks(document_id: str) -> dict:
        if not store.get_document(document_id):
            raise HTTPException(404, "资料不存在。")
        return {
            "document_id": document_id,
            "chunks": store.get_chunks(document_id),
        }

    @app.delete("/api/documents/{document_id}", status_code=204)
    def delete_document(document_id: str) -> None:
        try:
            deleted = store.delete_document(document_id)
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "资料删除与当前状态冲突，请刷新后重试。") from exc
        except Exception as exc:
            raise HTTPException(500, "删除资料失败，请稍后重试。") from exc
        if not deleted:
            raise HTTPException(404, "资料不存在。")

    @app.post("/api/search")
    async def search(request: QuestionRequest) -> dict:
        try:
            return await rag.retrieve(request.question, top_k(request))
        except ProviderError as exc:
            raise HTTPException(
                502, "上游 Embedding 服务请求失败，请稍后重试。"
            ) from exc

    @app.post("/api/ask")
    async def ask(request: QuestionRequest) -> dict:
        try:
            return await rag.ask(request.question, top_k(request))
        except ProviderError as exc:
            raise HTTPException(
                502, "上游 AI 服务请求失败，请稍后重试。"
            ) from exc

    return app


app = create_app()
