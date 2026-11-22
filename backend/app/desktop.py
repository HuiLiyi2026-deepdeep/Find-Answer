import socket
import sys
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


def bundled_web_dir() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
    return base / "web"


def choose_port(preferred: int = 8000) -> int:
    candidates = list(range(preferred, preferred + 20))
    for port in candidates:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def attach_frontend(application: FastAPI, web_dir: Path) -> None:
    web_dir = Path(web_dir).resolve()
    index = web_dir / "index.html"
    if not index.is_file():
        raise FileNotFoundError(f"Missing frontend entry: {index}")

    assets = web_dir / "assets"
    if assets.is_dir():
        application.mount("/assets", StaticFiles(directory=assets), name="assets")

    @application.get("/{path:path}", include_in_schema=False)
    def serve_frontend(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404)
        if path:
            candidate = (web_dir / path).resolve()
            if candidate.is_relative_to(web_dir) and candidate.is_file():
                return FileResponse(candidate)
            if Path(path).suffix:
                raise HTTPException(404)
        return FileResponse(index)
