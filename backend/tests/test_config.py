import app.config as config_module
from app.config import BACKEND_DIR, Settings


def test_findanswer_environment_names_configure_storage_and_retrieval(
    monkeypatch, tmp_path
):
    data_dir = tmp_path / "custom-data"
    monkeypatch.setenv("FINDANSWER_DATA_DIR", str(data_dir))
    monkeypatch.setenv("FINDANSWER_RETRIEVAL_THRESHOLD", "0.42")

    settings = Settings.from_env()

    assert settings.data_dir == data_dir
    assert settings.score_threshold == 0.42


def test_legacy_environment_names_are_not_aliases(monkeypatch, tmp_path):
    monkeypatch.delenv("FINDANSWER_DATA_DIR", raising=False)
    monkeypatch.delenv("FINDANSWER_RETRIEVAL_THRESHOLD", raising=False)
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "legacy-data"))
    monkeypatch.setenv("SCORE_THRESHOLD", "0.99")

    settings = Settings.from_env()

    assert settings.data_dir == BACKEND_DIR / "data"
    assert settings.score_threshold == 0.25


def test_packaged_runtime_uses_local_app_data(monkeypatch, tmp_path):
    monkeypatch.delenv("FINDANSWER_DATA_DIR", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    monkeypatch.setattr(config_module.sys, "frozen", True, raising=False)

    settings = Settings.from_env()

    assert settings.data_dir == tmp_path / "FindAnswer" / "data"


def test_environment_override_wins_in_packaged_runtime(monkeypatch, tmp_path):
    custom = tmp_path / "custom-data"
    monkeypatch.setenv("FINDANSWER_DATA_DIR", str(custom))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local"))
    monkeypatch.setattr(config_module.sys, "frozen", True, raising=False)

    settings = Settings.from_env()

    assert settings.data_dir == custom
