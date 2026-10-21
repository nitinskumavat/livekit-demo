import os
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def import_agent_with(provider: str) -> subprocess.CompletedProcess[str]:
    # A fresh process, because agent.py validates LLM_PROVIDER once at import.
    return subprocess.run(
        [sys.executable, "-c", "import agent"],
        cwd=BACKEND_DIR,
        env={**os.environ, "LLM_PROVIDER": provider},
        capture_output=True,
        text=True,
        timeout=60,
    )


def test_unknown_llm_provider_stops_at_startup() -> None:
    result = import_agent_with("Gemini")  # wrong case

    assert result.returncode != 0
    assert "Unknown LLM_PROVIDER 'Gemini'" in result.stderr


def test_known_llm_provider_imports() -> None:
    result = import_agent_with("gemini")

    assert result.returncode == 0, result.stderr
