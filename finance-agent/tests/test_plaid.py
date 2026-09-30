"""
Tests for /api/plaid/* (app/plaid_routes.py), the token encryption and the category map.

Same approach as the rest of the suite: no network. Supabase is an in-memory fake that
applies the same household filter RLS would and records every write; Plaid is a fake client
with scripted responses. The Plaid access token used here is a recognisable string, so the
tests can assert it never appears in a response or in the database unencrypted.
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402
from cryptography.fernet import Fernet  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import main, plaid_categories, plaid_client, plaid_routes, token_crypto  # noqa: E402
from app.plaid_client import PlaidError  # noqa: E402

client = TestClient(main.app)
USER = {"id": "user-ali", "email": "ali@example.com"}
PLAID_TOKEN = "access-sandbox-SECRET-TOKEN-123"
BODY = {"access_token": "jwt"}


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class Resp:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table, self.op, self.payload, self.filters, self.opts = db, table, "select", None, [], {}

    def select(self, *_a, **_k):
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def upsert(self, payload, **opts):
        self.op, self.payload, self.opts = "upsert", payload, opts
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, field, value):
        self.filters.append(lambda r: r.get(field) == value)
        return self

    def in_(self, field, values):
        self.filters.append(lambda r: r.get(field) in values)
        return self

    def limit(self, _n):
        return self

    def execute(self):
        if self.table in self.db.fail_on:
            raise RuntimeError(f"{self.table} write failed")
        rows = self.db.tables.setdefault(self.table, [])
        match = [r for r in rows if all(f(r) for f in self.filters)]
        self.db.log.append((self.op, self.table, self.payload, self.opts))
        if self.op == "select":
            return Resp([dict(r) for r in match])
        if self.op == "insert":
            rows.append(dict(self.payload))
            return Resp([self.payload])
        if self.op == "upsert":
            keys = self.opts["on_conflict"].split(",")
            for new in self.payload:
                old = next((r for r in rows if all(r.get(k) == new[k] for k in keys)), None)
                if old:
                    old.update(new)
                else:
                    rows.append({"reviewed": False, **new})
            return Resp(self.payload)
        if self.op == "update":
            for r in match:
                r.update(self.payload)
            return Resp(match)
        if self.op == "delete":
            self.db.tables[self.table] = [r for r in rows if r not in match]
            return Resp(match)
        raise AssertionError(self.op)


class FakeDB:
    """Holds every household's rows; `for_household` hands out a view limited to one, as RLS
    would for that household's members."""

    def __init__(self):
        self.tables, self.log, self.fail_on = {}, [], set()

    def table(self, name):
        return FakeQuery(self, name)

    def writes(self, table):
        return [entry for entry in self.log if entry[1] == table and entry[0] != "select"]


class FakePlaid:
    def __init__(self, pages=None, errors=None):
        self.pages = pages or {}        # cursor -> response (None = first page)
        self.errors = errors or {}      # method -> list of PlaidErrors to raise first
        self.calls = []

    def _maybe_fail(self, name):
        queue = self.errors.get(name) or []
        if queue:
            raise queue.pop(0)

    def link_token_create(self, client_user_id):
        self.calls.append(("link_token_create", client_user_id))
        self._maybe_fail("link_token_create")
        return {"link_token": "link-sandbox-abc", "expiration": "2026-09-30T12:00:00Z"}

    def item_public_token_exchange(self, public_token):
        self.calls.append(("exchange", public_token))
        self._maybe_fail("exchange")
        return {"access_token": PLAID_TOKEN, "item_id": "item-1"}

    def item_get(self, access_token):
        self.calls.append(("item_get", access_token))
        return {"item": {"institution_id": "ins_109508"}}

    def institution_name(self, institution_id):
        return "First Platypus Bank"

    def item_remove(self, access_token):
        self.calls.append(("item_remove", access_token))
        return {}

    def transactions_sync(self, access_token, cursor):
        self.calls.append(("sync", access_token, cursor))
        self._maybe_fail("sync")
        return self.pages[cursor]


def txn(tid, amount, detailed="FOOD_AND_DRINK_GROCERIES", pending=False, merchant="Whole Foods"):
    return {"transaction_id": tid, "amount": amount, "date": "2026-09-20", "pending": pending,
            "merchant_name": merchant, "name": "RAW NAME " + tid,
            "personal_finance_category": {"primary": detailed.split("_AND_")[0] if "_AND_" in detailed else detailed.rsplit("_", 1)[0], "detailed": detailed}}


@pytest.fixture
def env(monkeypatch):
    key = Fernet.generate_key().decode()
    monkeypatch.setenv("PLAID_TOKEN_ENCRYPTION_KEY", key)
    db = FakeDB()
    plaid = FakePlaid()
    monkeypatch.setattr(plaid_routes, "plaid_client_from_env", lambda: plaid)
    monkeypatch.setattr(plaid_routes, "get_user", lambda token: USER)
    monkeypatch.setattr(plaid_routes, "client_for_user", lambda token: db)
    monkeypatch.setattr(plaid_routes, "get_household_id", lambda sb: "h1")
    return {"db": db, "plaid": plaid, "monkeypatch": monkeypatch}


def linked_item(db, cursor=None, household="h1", item_id="item-1"):
    db.tables.setdefault("plaid_items", []).append({
        "id": "row-" + item_id, "household_id": household, "item_id": item_id, "institution_name": "First Platypus Bank",
        "access_token": token_crypto.encrypt_token(PLAID_TOKEN), "cursor": cursor, "linked_by": USER["id"]})


# ---------------------------------------------------------------------------
# Encryption
# ---------------------------------------------------------------------------

def test_token_round_trips_and_ciphertext_hides_it(monkeypatch):
    monkeypatch.setenv("PLAID_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
    ciphertext = token_crypto.encrypt_token(PLAID_TOKEN)
    assert PLAID_TOKEN not in ciphertext
    assert token_crypto.decrypt_token(ciphertext) == PLAID_TOKEN


def test_wrong_or_missing_key_fails_without_leaking(monkeypatch):
    monkeypatch.setenv("PLAID_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
    ciphertext = token_crypto.encrypt_token(PLAID_TOKEN)
    monkeypatch.setenv("PLAID_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())
    with pytest.raises(token_crypto.TokenCryptoError) as exc:
        token_crypto.decrypt_token(ciphertext)
    assert PLAID_TOKEN not in str(exc.value)
    monkeypatch.setenv("PLAID_TOKEN_ENCRYPTION_KEY", "not-a-key")
    assert token_crypto.key_configured() is False
    monkeypatch.delenv("PLAID_TOKEN_ENCRYPTION_KEY")
    assert token_crypto.key_configured() is False


# ---------------------------------------------------------------------------
# Configuration: sandbox only, closed until every setting is present
# ---------------------------------------------------------------------------

def test_plaid_client_refuses_anything_but_sandbox(monkeypatch):
    monkeypatch.setenv("PLAID_CLIENT_ID", "cid")
    monkeypatch.setenv("PLAID_SECRET_SANDBOX", "secret")
    for env_name in ("", "production", "development"):
        monkeypatch.setenv("PLAID_ENV", env_name)
        with pytest.raises(plaid_client.PlaidNotConfigured):
            plaid_client.plaid_client_from_env()
    monkeypatch.setenv("PLAID_ENV", "sandbox")
    c = plaid_client.plaid_client_from_env()
    assert "secret" not in repr(c)


def test_endpoints_are_503_until_configured(monkeypatch):
    for name in ("PLAID_ENV", "PLAID_CLIENT_ID", "PLAID_SECRET_SANDBOX", "PLAID_TOKEN_ENCRYPTION_KEY"):
        monkeypatch.delenv(name, raising=False)
    for path in ("/api/plaid/link-token", "/api/plaid/sync"):
        assert client.post(path, json=BODY).status_code == 503
    # Plaid settings present but no encryption key: still closed, so a token is never stored in the clear.
    monkeypatch.setattr(plaid_routes, "plaid_client_from_env", lambda: FakePlaid())
    resp = client.post("/api/plaid/exchange", json={**BODY, "public_token": "p"})
    assert resp.status_code == 503
    assert "PLAID_TOKEN_ENCRYPTION_KEY" in resp.json()["detail"]


def test_plaid_client_sends_secrets_in_headers_and_raises_plaid_errors():
    import httpx

    seen = {}

    def handler(request):
        seen["headers"], seen["body"] = request.headers, json.loads(request.content)
        if request.url.path == "/item/public_token/exchange":
            return httpx.Response(400, json={"error_type": "INVALID_INPUT", "error_code": "INVALID_PUBLIC_TOKEN", "error_message": "bad token"})
        return httpx.Response(200, json={"link_token": "link-1"})

    c = plaid_client.PlaidClient("cid", "shh", "sandbox", http=httpx.Client(transport=httpx.MockTransport(handler)))
    assert c.link_token_create("user-ali")["link_token"] == "link-1"
    assert seen["headers"]["PLAID-SECRET"] == "shh" and "secret" not in seen["body"]
    assert seen["body"]["user"] == {"client_user_id": "user-ali"} and seen["body"]["products"] == ["transactions"]
    with pytest.raises(PlaidError) as exc:
        c.item_public_token_exchange("public-bad")
    assert exc.value.error_code == "INVALID_PUBLIC_TOKEN" and exc.value.status == 400


# ---------------------------------------------------------------------------
# Session checks (same as /api/chat)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path,extra", [("/api/plaid/link-token", {}), ("/api/plaid/exchange", {"public_token": "p"}), ("/api/plaid/sync", {})])
def test_invalid_session_is_401_and_no_household_is_403(env, path, extra):
    env["monkeypatch"].setattr(plaid_routes, "get_user", lambda token: None)
    assert client.post(path, json={**BODY, **extra}).status_code == 401
    env["monkeypatch"].setattr(plaid_routes, "get_user", lambda token: USER)
    env["monkeypatch"].setattr(plaid_routes, "get_household_id", lambda sb: None)
    assert client.post(path, json={**BODY, **extra}).status_code == 403
    assert env["plaid"].calls == []  # Plaid is never called for an unverified caller


# ---------------------------------------------------------------------------
# /api/plaid/link-token and /api/plaid/exchange
# ---------------------------------------------------------------------------

def test_link_token_is_created_for_the_verified_user(env):
    resp = client.post("/api/plaid/link-token", json=BODY)
    assert resp.status_code == 200
    assert resp.json() == {"link_token": "link-sandbox-abc", "expiration": "2026-09-30T12:00:00Z"}
    assert env["plaid"].calls == [("link_token_create", "user-ali")]


def test_exchange_stores_the_token_encrypted_and_never_returns_it(env):
    resp = client.post("/api/plaid/exchange", json={**BODY, "public_token": "public-sandbox-1"})
    assert resp.status_code == 200
    assert resp.json() == {"item_id": "item-1", "institution_name": "First Platypus Bank"}
    assert PLAID_TOKEN not in resp.text

    [row] = env["db"].tables["plaid_items"]
    assert row["household_id"] == "h1" and row["linked_by"] == "user-ali" and row["item_id"] == "item-1"
    assert PLAID_TOKEN not in json.dumps(row)
    assert token_crypto.decrypt_token(row["access_token"]) == PLAID_TOKEN
    assert row.get("cursor") is None


def test_exchange_passes_on_a_bad_public_token_as_400(env):
    env["plaid"].errors["exchange"] = [PlaidError(400, "INVALID_INPUT", "INVALID_PUBLIC_TOKEN", "bad")]
    resp = client.post("/api/plaid/exchange", json={**BODY, "public_token": "nope"})
    assert resp.status_code == 400
    assert "INVALID_PUBLIC_TOKEN" in resp.json()["detail"]
    assert "plaid_items" not in env["db"].tables


def test_exchange_removes_the_item_at_plaid_if_it_cant_be_saved(env):
    env["db"].fail_on.add("plaid_items")
    resp = client.post("/api/plaid/exchange", json={**BODY, "public_token": "public-sandbox-1"})
    assert resp.status_code == 500
    assert PLAID_TOKEN not in resp.text
    assert ("item_remove", PLAID_TOKEN) in env["plaid"].calls


# ---------------------------------------------------------------------------
# /api/plaid/sync
# ---------------------------------------------------------------------------

def test_sync_pages_through_queues_and_saves_the_final_cursor(env):
    db, plaid = env["db"], env["plaid"]
    linked_item(db)
    plaid.pages = {
        None: {"added": [txn("t1", 54.20), txn("t2", -2500.0, "INCOME_WAGES", merchant=None)], "modified": [], "removed": [],
               "next_cursor": "c1", "has_more": True},
        "c1": {"added": [txn("t3", 12.5, "FOOD_AND_DRINK_COFFEE"), txn("t4", 8.0, pending=True)], "modified": [], "removed": [],
               "next_cursor": "c2", "has_more": False},
    }
    resp = client.post("/api/plaid/sync", json=BODY)
    assert resp.status_code == 200
    assert resp.json()["items"] == [{"item_id": "item-1", "institution_name": "First Platypus Bank", "status": "ok",
                                     "queued": 3, "removed": 0, "skipped_pending": 1, "error_code": None}]
    assert PLAID_TOKEN not in resp.text
    assert [c[2] for c in plaid.calls] == [None, "c1"]
    assert all(c[1] == PLAID_TOKEN for c in plaid.calls)  # decrypted for the call itself

    queue = {r["plaid_transaction_id"]: r for r in db.tables["plaid_review_queue"]}
    assert queue["t1"]["type"] == "expense" and queue["t1"]["amount"] == 54.2 and queue["t1"]["suggested_category"] == "Groceries"
    assert queue["t2"]["type"] == "income" and queue["t2"]["amount"] == 2500.0 and queue["t2"]["suggested_category"] == "Salary"
    assert queue["t2"]["merchant_name"] == "RAW NAME t2"  # falls back to Plaid's raw name
    assert queue["t3"]["suggested_category"] == "Coffee"
    assert queue["t1"]["raw_plaid_data"]["transaction_id"] == "t1"
    assert all(r["household_id"] == "h1" and r["reviewed"] is False for r in queue.values())
    assert db.tables["plaid_items"][0]["cursor"] == "c2"
    assert "transactions" not in db.tables  # the review queue only, never the ledger


def test_sync_is_idempotent_and_keeps_reviewed_rows_reviewed(env):
    db, plaid = env["db"], env["plaid"]
    linked_item(db)
    plaid.pages = {None: {"added": [txn("t1", 54.20)], "modified": [], "removed": [], "next_cursor": "c1", "has_more": False}}
    client.post("/api/plaid/sync", json=BODY)
    db.tables["plaid_review_queue"][0]["reviewed"] = True
    db.tables["plaid_items"][0]["cursor"] = None  # as if the cursor save had failed last time
    client.post("/api/plaid/sync", json=BODY)
    [row] = db.tables["plaid_review_queue"]
    assert row["reviewed"] is True
    [upsert_opts] = {json.dumps(e[3]) for e in db.writes("plaid_review_queue")}
    assert json.loads(upsert_opts) == {"on_conflict": "household_id,plaid_transaction_id"}


def test_sync_applies_modified_and_removed(env):
    db, plaid = env["db"], env["plaid"]
    linked_item(db, cursor="c1")
    db.tables["plaid_review_queue"] = [
        {"household_id": "h1", "plaid_transaction_id": "t1", "amount": 10.0, "reviewed": False},
        {"household_id": "h1", "plaid_transaction_id": "t2", "amount": 20.0, "reviewed": False},
        {"household_id": "h1", "plaid_transaction_id": "t3", "amount": 30.0, "reviewed": True},
    ]
    plaid.pages = {"c1": {"added": [], "modified": [txn("t1", 11.0)], "removed": [{"transaction_id": "t2"}, {"transaction_id": "t3"}],
                          "next_cursor": "c2", "has_more": False}}
    item = client.post("/api/plaid/sync", json=BODY).json()["items"][0]
    assert item["queued"] == 1 and item["removed"] == 1
    queue = {r["plaid_transaction_id"]: r for r in db.tables["plaid_review_queue"]}
    assert queue["t1"]["amount"] == 11.0
    assert "t2" not in queue
    assert "t3" in queue  # reviewed rows are the household's decision, not Plaid's


def test_sync_restarts_from_the_first_cursor_after_a_mutation_during_pagination(env):
    db, plaid = env["db"], env["plaid"]
    linked_item(db, cursor="c0")
    plaid.pages = {"c0": {"added": [txn("t1", 5.0)], "modified": [], "removed": [], "next_cursor": "c1", "has_more": True},
                   "c1": {"added": [txn("t2", 6.0)], "modified": [], "removed": [], "next_cursor": "c2", "has_more": False}}
    real_sync = plaid.transactions_sync
    state = {"n": 0}

    def flaky(access_token, cursor):
        state["n"] += 1
        if state["n"] == 2:  # second page of the first attempt
            raise PlaidError(400, "TRANSACTIONS_ERROR", plaid_routes.MUTATION_DURING_PAGINATION, "restart")
        return real_sync(access_token, cursor)

    plaid.transactions_sync = flaky
    item = client.post("/api/plaid/sync", json=BODY).json()["items"][0]
    assert item["status"] == "ok" and item["queued"] == 2
    assert [c[2] for c in plaid.calls] == ["c0", "c0", "c1"]
    assert db.tables["plaid_items"][0]["cursor"] == "c2"


def test_one_broken_item_doesnt_stop_the_others(env):
    db, plaid = env["db"], env["plaid"]
    linked_item(db, item_id="item-1")
    linked_item(db, item_id="item-2", cursor="x")
    plaid.errors["sync"] = [PlaidError(400, "ITEM_ERROR", "ITEM_LOGIN_REQUIRED", "relink")]
    plaid.pages = {"x": {"added": [txn("t9", 3.0)], "modified": [], "removed": [], "next_cursor": "y", "has_more": False}}
    items = {i["item_id"]: i for i in client.post("/api/plaid/sync", json=BODY).json()["items"]}
    assert items["item-1"]["status"] == "error" and items["item-1"]["error_code"] == "ITEM_LOGIN_REQUIRED"
    assert items["item-2"]["status"] == "ok" and items["item-2"]["queued"] == 1
    cursors = {r["item_id"]: r["cursor"] for r in db.tables["plaid_items"]}
    assert cursors == {"item-1": None, "item-2": "y"}  # the failed item's cursor didn't move


def test_sync_only_touches_the_callers_household(env):
    db, plaid = env["db"], env["plaid"]
    linked_item(db, household="h2", item_id="theirs")
    assert client.post("/api/plaid/sync", json=BODY).json() == {"items": []}
    assert client.post("/api/plaid/sync", json={**BODY, "item_id": "theirs"}).status_code == 404
    assert plaid.calls == []


def test_undecryptable_token_is_reported_not_crashed(env):
    db = env["db"]
    linked_item(db)
    env["monkeypatch"].setenv("PLAID_TOKEN_ENCRYPTION_KEY", Fernet.generate_key().decode())  # key rotated
    [item] = client.post("/api/plaid/sync", json=BODY).json()["items"]
    assert item["status"] == "error" and item["error_code"] == "TOKEN_UNREADABLE"


# ---------------------------------------------------------------------------
# Category map
# ---------------------------------------------------------------------------

def app_categories():
    """ledger-app's categories per type, read from src/main.js."""
    src = open(os.path.join(os.path.dirname(__file__), "..", "..", "src", "main.js")).read()
    block = src[src.index("const CATEGORIES = {"):src.index("};", src.index("const CATEGORIES = {"))]
    expense, income = block.split("income:")
    names = lambda part: {n for group in re.findall(r"\[\s*\"[^\"]+\",\s*\[([^\]]*)\]", part) for n in re.findall(r"\"([^\"]+)\"", group)}
    return {"expense": names(expense), "income": names(income)}


def test_every_suggested_category_exists_in_the_app():
    cats = app_categories()
    assert "Groceries" in cats["expense"] and "Salary" in cats["income"]
    for value in {*plaid_categories.EXPENSE_DETAILED.values(), *plaid_categories.EXPENSE_PRIMARY.values(), "Other"}:
        assert value in cats["expense"], value
    for value in {*plaid_categories.INCOME_DETAILED.values(), "Refunds & reimbursements", "Other"}:
        assert value in cats["income"], value


def test_suggest_category():
    s = plaid_categories.suggest_category
    assert s({"primary": "FOOD_AND_DRINK", "detailed": "FOOD_AND_DRINK_GROCERIES"}, "expense") == "Groceries"
    assert s({"primary": "FOOD_AND_DRINK", "detailed": "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR"}, "expense") == "Restaurants & takeout"
    assert s({"primary": "TRANSFER_OUT", "detailed": "TRANSFER_OUT_ACCOUNT_TRANSFER"}, "expense") == "Other"
    assert s(None, "expense") == "Other"
    assert s({"primary": "INCOME", "detailed": "INCOME_WAGES"}, "income") == "Salary"
    assert s({"primary": "GENERAL_MERCHANDISE", "detailed": "GENERAL_MERCHANDISE_ELECTRONICS"}, "income") == "Refunds & reimbursements"
    assert s({"primary": "TRANSFER_IN", "detailed": "TRANSFER_IN_DEPOSIT"}, "income") == "Other"
