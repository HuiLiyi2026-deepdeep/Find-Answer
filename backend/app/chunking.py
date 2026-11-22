import re
from bisect import bisect_right
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader


SUPPORTED_EXTENSIONS = {".txt", ".md", ".markdown", ".pdf"}


@dataclass(slots=True)
class SourceChunk:
    id: str
    document_id: str
    file_name: str
    page: int | None
    chunk_index: int
    text: str

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "document_id": self.document_id,
            "file_name": self.file_name,
            "page": self.page,
            "chunk_index": self.chunk_index,
            "text": self.text,
        }


def extract_text(file_name: str, content: bytes) -> list[tuple[int | None, str]]:
    extension = Path(file_name).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError("仅支持 TXT、Markdown 和文字型 PDF 文件。")

    if extension == ".pdf":
        try:
            reader = PdfReader(BytesIO(content), strict=False)
            if reader.is_encrypted:
                raise ValueError("不支持加密 PDF 文件。")
            pages = []
            for number, page in enumerate(reader.pages, start=1):
                text = (page.extract_text() or "").strip()
                if text:
                    pages.append((number, text))
            return pages
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError("PDF 无法解析，请上传包含可选文字的有效 PDF。") from exc

    try:
        text = content.decode("utf-8-sig").strip()
    except UnicodeDecodeError as exc:
        raise ValueError("文本文件必须使用 UTF-8 编码。") from exc
    return [(None, text)] if text else []


def chunk_pages(
    document_id: str,
    file_name: str,
    pages: list[tuple[int | None, str]],
    chunk_size: int = 600,
    overlap: int = 80,
) -> list[SourceChunk]:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    if overlap < 0 or overlap >= chunk_size:
        raise ValueError("overlap must be between 0 and chunk_size - 1")

    chunks: list[SourceChunk] = []

    def append(page: int | None, text: str) -> None:
        index = len(chunks)
        chunks.append(
            SourceChunk(
                id=f"{document_id}:{index}",
                document_id=document_id,
                file_name=file_name,
                page=page,
                chunk_index=index,
                text=text,
            )
        )

    for page, page_text in pages:
        text = page_text.strip()
        if not text:
            continue

        paragraph_ends = [
            match.start() for match in re.finditer(r"\n\s*\n", text)
        ]
        start = 0
        previous_end = 0
        while start < len(text):
            maximum_end = min(start + chunk_size, len(text))
            if maximum_end == len(text):
                end = maximum_end
            else:
                candidate_index = bisect_right(paragraph_ends, maximum_end) - 1
                if (
                    candidate_index >= 0
                    and paragraph_ends[candidate_index] > previous_end
                ):
                    end = paragraph_ends[candidate_index]
                else:
                    end = maximum_end

            content_start = start
            content_end = end
            while content_start < content_end and text[content_start].isspace():
                content_start += 1
            while content_end > content_start and text[content_end - 1].isspace():
                content_end -= 1
            if content_start < content_end:
                append(page, text[content_start:content_end])

            if end == len(text):
                break
            previous_end = end
            start = max(start + 1, end - overlap)

    return chunks
