import socket

from fastapi.testclient import TestClient

from app.config import Settings
from app.desktop import attach_frontend, choose_port
from app.main import create_app


class EmptyStore:
    def count_documents(self):
        return 0

    def count_chunks(self):
        return 0


class FakeProvider:
    api_key = ""

    async def embed(self, texts):
        return [[0.0] for _ in texts]

    async def complete(self, messages):
        return "NO_ANSWER"


class FakeCredentials:
    def get(self, provider):
        return None

    def set(self, provider, api_key):
        pass


def make_client(tmp_path):
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text(
        "<html><title>FindAnswer</title></html>", encoding="utf-8"
    )
    (web / "assets" / "app.js").write_text("console.log('ok')", encoding="utf-8")
    app = create_app(
        settings=Settings(data_dir=tmp_path / "data"),
        store=EmptyStore(),
        embedding_provider=FakeProvider(),
        chat_provider=FakeProvider(),
        credential_store=FakeCredentials(),
    )
    attach_frontend(app, web)
    return TestClient(app)


def test_root_serves_frontend_index(tmp_path):
    response = make_client(tmp_path).get("/")

    assert response.status_code == 200
    assert "FindAnswer" in response.text


def test_client_routes_fall_back_to_index(tmp_path):
    response = make_client(tmp_path).get("/connections")

    assert response.status_code == 200
    assert "FindAnswer" in response.text


def test_built_assets_are_served(tmp_path):
    response = make_client(tmp_path).get("/assets/app.js")

    assert response.status_code == 200
    assert response.text == "console.log('ok')"


def test_api_routes_keep_working(tmp_path):
    response = make_client(tmp_path).get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_unknown_api_route_is_not_replaced_by_index(tmp_path):
    response = make_client(tmp_path).get("/api/unknown")

    assert response.status_code == 404


def test_missing_static_file_is_not_replaced_by_index(tmp_path):
    response = make_client(tmp_path).get("/missing.png")

    assert response.status_code == 404


def test_choose_port_returns_free_preferred_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        free = probe.getsockname()[1]

    assert choose_port(free) == free


def test_choose_port_skips_busy_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        taken = busy.getsockname()[1]

        assert choose_port(taken) != taken
