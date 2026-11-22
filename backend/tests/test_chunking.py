import pytest

from app.chunking import chunk_pages, extract_text


def test_chinese_paragraphs_keep_page_and_source_metadata():
    chunks = chunk_pages(
        document_id="doc-1",
        file_name="学习.md",
        pages=[
            (1, "第一段：深度学习。\n\n第二段：检索增强。"),
            (2, "第三页保留原文。"),
        ],
    )

    assert [chunk.text for chunk in chunks] == [
        "第一段：深度学习。\n\n第二段：检索增强。",
        "第三页保留原文。",
    ]
    assert [chunk.page for chunk in chunks] == [1, 2]
    assert [chunk.chunk_index for chunk in chunks] == [0, 1]
    assert all(chunk.document_id == "doc-1" for chunk in chunks)
    assert all(chunk.file_name == "学习.md" for chunk in chunks)


def test_long_chinese_text_uses_character_overlap():
    chunks = chunk_pages(
        document_id="doc-2",
        file_name="长文.txt",
        pages=[(None, "一二三四五六七八九十")],
        chunk_size=6,
        overlap=2,
    )

    assert [chunk.text for chunk in chunks] == [
        "一二三四五六",
        "五六七八九十",
    ]


def test_paragraph_boundaries_keep_character_overlap():
    chunks = chunk_pages(
        document_id="doc-overlap",
        file_name="段落.txt",
        pages=[(None, "甲甲\n\n乙乙\n\n丙丙")],
        chunk_size=6,
        overlap=2,
    )

    assert [chunk.text for chunk in chunks] == [
        "甲甲\n\n乙乙",
        "乙乙\n\n丙丙",
    ]


def test_chunks_preserve_internal_whitespace_as_source_substrings():
    pages = extract_text(
        "空白.md",
        "  第一段  \n\n\t第二段\t\n\n第三段  ".encode(),
    )

    chunks = chunk_pages(
        document_id="doc-whitespace",
        file_name="空白.md",
        pages=pages,
        chunk_size=18,
        overlap=4,
    )

    assert all(chunk.text in pages[0][1] for chunk in chunks)
    assert any("\t第二段\t" in chunk.text for chunk in chunks)


def test_text_extraction_supports_utf8_bom():
    assert extract_text("笔记.txt", b"\xef\xbb\xbf\xe4\xbd\xa0\xe5\xa5\xbd") == [
        (None, "你好")
    ]


def test_invalid_overlap_is_rejected():
    with pytest.raises(ValueError):
        chunk_pages(
            document_id="doc",
            file_name="a.txt",
            pages=[(None, "text")],
            chunk_size=10,
            overlap=10,
        )
