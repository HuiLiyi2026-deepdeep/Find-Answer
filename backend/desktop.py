"""Entry point for the packaged Windows app: a local WebView2 window."""

import json
import logging
import os
import sys
import threading
import time
import urllib.request
from pathlib import Path


APP_TITLE = "FindAnswer"
MUTEX_NAME = "Local\\FindAnswer.Desktop"


def _app_dir() -> Path:
    value = os.getenv("LOCALAPPDATA")
    base = Path(value) if value else Path.home() / "AppData" / "Local"
    return base / "FindAnswer"


def _log_path() -> Path:
    return _app_dir() / "logs" / "desktop.log"


def _runtime_path() -> Path:
    return _app_dir() / "runtime.json"


def _configure_logging() -> None:
    path = _log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=path,
        level=logging.INFO,
        encoding="utf-8",
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def _show_message(text: str, error: bool = False) -> None:
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(
            None, text, APP_TITLE, 0x10 if error else 0x40
        )
    except Exception:
        logging.exception("Could not show a message box")


def _acquire_lock():
    if sys.platform != "win32":
        return object()
    import ctypes

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        return None
    if kernel32.GetLastError() == 183:
        kernel32.CloseHandle(handle)
        return None
    return handle


def _read_runtime() -> dict | None:
    try:
        payload = json.loads(_runtime_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _write_runtime(port: int) -> None:
    path = _runtime_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"port": port, "pid": os.getpid()}), encoding="utf-8"
    )


def _clear_runtime() -> None:
    payload = _read_runtime()
    if payload and payload.get("pid") == os.getpid():
        _runtime_path().unlink(missing_ok=True)


def _focus_running_window() -> bool:
    payload = _read_runtime()
    if not payload:
        return False
    pid = payload.get("pid")
    if not isinstance(pid, int):
        return False

    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    handles: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def collect(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            handles.append(hwnd)
            return False
        return True

    user32.EnumWindows(collect, 0)
    if not handles:
        return False

    hwnd = handles[0]
    user32.ShowWindow(hwnd, 9)
    user32.SetForegroundWindow(hwnd)
    return True


def _wait_and_focus_window(timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _focus_running_window():
            return True
        time.sleep(0.3)
    return False


def _health_ok(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/health", timeout=1
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return False
    return payload.get("status") == "ok"


def _wait_health(port: int, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _health_ok(port):
            return True
        time.sleep(0.3)
    return False


def main() -> None:
    _configure_logging()
    logging.info("FindAnswer desktop starting")

    lock = _acquire_lock()
    if lock is None:
        if _wait_and_focus_window():
            logging.info("Existing FindAnswer window focused")
            return
        _show_message("FindAnswer 已在运行，请在任务栏中切换到它的窗口。")
        return

    import uvicorn

    from app.desktop import attach_frontend, bundled_web_dir, choose_port
    from app.main import app

    web_dir = bundled_web_dir()
    if not (web_dir / "index.html").is_file():
        raise RuntimeError(f"缺少前端文件：{web_dir}")
    attach_frontend(app, web_dir)

    port = choose_port(8000)
    url = f"http://127.0.0.1:{port}"
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            log_config=None,
            access_log=False,
        )
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    if not _wait_health(port, 60):
        server.should_exit = True
        thread.join(10)
        raise RuntimeError("本地服务启动超时")

    _write_runtime(port)
    logging.info("Local server ready at %s", url)

    try:
        import webview

        webview.create_window(
            APP_TITLE,
            url,
            width=1280,
            height=860,
            min_size=(960, 640),
            background_color="#f4f4f1",
        )
        webview.start()
    finally:
        server.should_exit = True
        thread.join(10)
        _clear_runtime()
        logging.info("FindAnswer desktop stopped")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logging.exception("FindAnswer failed to start")
        _show_message(
            "FindAnswer 启动失败。\n\n详细信息已写入：\n" + str(_log_path()),
            error=True,
        )
