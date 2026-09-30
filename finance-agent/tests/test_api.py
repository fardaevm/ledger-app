"""
Tests for the HTTP layer in app/main.py: the /api routes Vercel serves, the email
allowlist, and the request size caps. Supabase and the agent are stubbed, so no network.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.agent import AgentResult  # noqa: E402

client = TestClient(main.app)
BODY = {"access_token": "t", "message": "How are we doing?", "history": []}


@pytest.fixture
def env(monkeypatch):
    # Start every test from a known environment, whatever a local .env loaded.
    for name in ("ANTHROPIC_API_KEY", "ASSISTANT_ALLOWED_EMAILS"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(main, "get_user_email", lambda token: "ali@example.com")
    monkeypatch.setattr(main, "client_for_user", lambda token: object())
    monkeypatch.setattr(main, "get_household_id", lambda sb: "h1")
    monkeypatch.setattr(main.agent, "run_agent", lambda **kw: AgentResult(reply="All good."))
    return monkeypatch


def test_health_is_served_under_api(env):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "assistant_ready": False}
    env.setenv("ANTHROPIC_API_KEY", "x")
    env.setenv("ASSISTANT_ALLOWED_EMAILS", "ali@example.com")
    assert client.get("/api/health").json()["assistant_ready"] is True


def test_chat_is_closed_until_an_allowlist_is_set(env):
    env.setenv("ANTHROPIC_API_KEY", "x")
    resp = client.post("/api/chat", json=BODY)
    assert resp.status_code == 503
    assert "ASSISTANT_ALLOWED_EMAILS" in resp.json()["detail"]


def test_chat_refuses_accounts_not_on_the_allowlist(env):
    env.setenv("ANTHROPIC_API_KEY", "x")
    env.setenv("ASSISTANT_ALLOWED_EMAILS", "sara@example.com, someone@example.com")
    assert client.post("/api/chat", json=BODY).status_code == 403


def test_chat_rejects_an_invalid_session(env):
    env.setenv("ANTHROPIC_API_KEY", "x")
    env.setenv("ASSISTANT_ALLOWED_EMAILS", "ali@example.com")
    env.setattr(main, "get_user_email", lambda token: None)
    assert client.post("/api/chat", json=BODY).status_code == 401


def test_chat_answers_an_allowed_user_case_insensitively(env):
    env.setenv("ANTHROPIC_API_KEY", "x")
    env.setenv("ASSISTANT_ALLOWED_EMAILS", "Sara@example.com,ALI@example.com")
    resp = client.post("/api/chat", json=BODY)
    assert resp.status_code == 200
    assert resp.json() == {"reply": "All good.", "tool_calls": []}


def test_chat_caps_request_size(env):
    env.setenv("ANTHROPIC_API_KEY", "x")
    env.setenv("ASSISTANT_ALLOWED_EMAILS", "ali@example.com")
    too_long = {**BODY, "message": "x" * 4001}
    assert client.post("/api/chat", json=too_long).status_code == 422
    too_much_history = {**BODY, "history": [{"role": "user", "content": "hi"}] * 41}
    assert client.post("/api/chat", json=too_much_history).status_code == 422


def test_old_unprefixed_paths_are_gone(env):
    assert client.get("/health").status_code == 404


def test_no_cors_headers_unless_configured(env):
    resp = client.options("/api/chat", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in resp.headers
