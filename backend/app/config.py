import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env", override=False)


def _packaged_data_dir() -> Path:
    local_app_data = os.getenv("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "FindAnswer" / "data"


def _data_dir_from_env() -> Path:
    raw = os.getenv("FINDANSWER_DATA_DIR")
    if raw:
        value = Path(raw).expanduser()
        return value if value.is_absolute() else BACKEND_DIR / value
    if getattr(sys, "frozen", False):
        return _packaged_data_dir()
    return BACKEND_DIR / "data"


@dataclass(slots=True)
class Settings:
    data_dir: Path = field(default_factory=_data_dir_from_env)
    siliconflow_api_key: str = ""
    deepseek_api_key: str = ""
    embedding_model: str = "BAAI/bge-m3"
    chat_model: str = "deepseek-chat"
    default_top_k: int = 5
    score_threshold: float = 0.25
    chunk_size: int = 600
    chunk_overlap: int = 80
    max_file_size: int = 20 * 1024 * 1024

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            data_dir=_data_dir_from_env(),
            siliconflow_api_key=os.getenv("SILICONFLOW_API_KEY", "").strip(),
            deepseek_api_key=os.getenv("DEEPSEEK_API_KEY", "").strip(),
            embedding_model=os.getenv(
                "SILICONFLOW_EMBEDDING_MODEL", "BAAI/bge-m3"
            ).strip(),
            chat_model=os.getenv("DEEPSEEK_MODEL", "deepseek-chat").strip(),
            default_top_k=int(os.getenv("DEFAULT_TOP_K", "5")),
            score_threshold=float(os.getenv("FINDANSWER_RETRIEVAL_THRESHOLD", "0.25")),
            chunk_size=int(os.getenv("CHUNK_SIZE", "600")),
            chunk_overlap=int(os.getenv("CHUNK_OVERLAP", "80")),
        )
