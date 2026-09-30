"""
A thin client for the handful of Plaid endpoints ledger-app uses, over httpx (already a
dependency of anthropic and supabase). Plaid's API is plain JSON over POST, and the official
plaid-python SDK is a large generated package that would slow every cold start of the
Vercel function for five calls.

Sandbox only in this version: PLAID_ENV must be "sandbox", and the secret is read from
PLAID_SECRET_SANDBOX. Production needs its own review (costs, allowlist, webhooks) first.

Secrets travel in headers, never in a logged body, and PlaidError messages carry only
Plaid's error code and message, never a request's contents or an access token.
"""

import os

import httpx

BASE_URLS = {"sandbox": "https://sandbox.plaid.com"}
TIMEOUT = httpx.Timeout(20.0, connect=5.0)


class PlaidNotConfigured(RuntimeError):
    """A PLAID_* setting is missing, or PLAID_ENV isn't sandbox."""


class PlaidError(RuntimeError):
    """Plaid answered with an error. error_code is Plaid's (e.g. ITEM_LOGIN_REQUIRED)."""

    def __init__(self, status: int, error_type: str, error_code: str, message: str):
        super().__init__(f"Plaid {error_code}: {message}")
        self.status = status
        self.error_type = error_type
        self.error_code = error_code


class PlaidClient:
    def __init__(self, client_id: str, secret: str, env: str = "sandbox", http: httpx.Client | None = None):
        if env not in BASE_URLS:
            raise PlaidNotConfigured(f"PLAID_ENV={env!r} isn't supported yet: only sandbox")
        self._base = BASE_URLS[env]
        self._headers = {"PLAID-CLIENT-ID": client_id, "PLAID-SECRET": secret, "Content-Type": "application/json"}
        self._http = http or httpx.Client(timeout=TIMEOUT)

    def __repr__(self) -> str:  # never print the secret
        return f"PlaidClient({self._base})"

    def _post(self, path: str, body: dict) -> dict:
        resp = self._http.post(self._base + path, json=body, headers=self._headers)
        try:
            data = resp.json()
        except ValueError:
            data = {}
        if resp.status_code >= 400:
            raise PlaidError(resp.status_code, data.get("error_type", "API_ERROR"),
                             data.get("error_code", "UNKNOWN"), data.get("error_message", resp.reason_phrase))
        return data

    def link_token_create(self, client_user_id: str) -> dict:
        return self._post("/link/token/create", {
            "client_name": "Ledger",
            "user": {"client_user_id": client_user_id},
            "products": ["transactions"],
            "country_codes": ["US"],
            "language": "en",
        })

    def item_public_token_exchange(self, public_token: str) -> dict:
        return self._post("/item/public_token/exchange", {"public_token": public_token})

    def item_get(self, access_token: str) -> dict:
        return self._post("/item/get", {"access_token": access_token})

    def institution_name(self, institution_id: str) -> str | None:
        data = self._post("/institutions/get_by_id", {"institution_id": institution_id, "country_codes": ["US"]})
        return (data.get("institution") or {}).get("name")

    def item_remove(self, access_token: str) -> dict:
        return self._post("/item/remove", {"access_token": access_token})

    def transactions_sync(self, access_token: str, cursor: str | None) -> dict:
        body = {"access_token": access_token, "count": 500}
        if cursor:
            body["cursor"] = cursor
        return self._post("/transactions/sync", body)


def plaid_client_from_env() -> PlaidClient:
    env = os.environ.get("PLAID_ENV", "")
    if env != "sandbox":
        raise PlaidNotConfigured("PLAID_ENV must be set to sandbox" if not env else f"PLAID_ENV={env!r} isn't supported yet: only sandbox")
    client_id = os.environ.get("PLAID_CLIENT_ID")
    secret = os.environ.get("PLAID_SECRET_SANDBOX")
    if not client_id or not secret:
        raise PlaidNotConfigured("PLAID_CLIENT_ID and PLAID_SECRET_SANDBOX must be set")
    return PlaidClient(client_id, secret, env)
