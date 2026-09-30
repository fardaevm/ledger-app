"""
Builds a Supabase client scoped to the calling user's own access token,
so every query the agent's tools run is subject to the same row-level
security policies as the frontend (see ledger-app/supabase/schema.sql).

Deliberately NOT using the service-role key here: the agent should never
be able to see more than the signed-in user could see themselves. If you
later need cross-household admin tooling, that's a different, explicitly
privileged client — don't reuse this one for it.
"""

import os

from supabase import Client, create_client


def _setting(name: str) -> str:
    """SUPABASE_URL / SUPABASE_ANON_KEY, falling back to the web app's VITE_ names. On Vercel
    the assistant runs in the same project as ledger-app, whose VITE_SUPABASE_URL and
    VITE_SUPABASE_ANON_KEY are already set (the anon key is public by design; RLS protects
    the data), so they don't need entering twice. Read per call, not at import, so a missing
    value fails the request that needs it rather than the whole function."""
    value = os.environ.get(name) or os.environ.get(f"VITE_{name}")
    if not value:
        raise RuntimeError(f"{name} (or VITE_{name}) is not set")
    return value


def client_for_user(access_token: str) -> Client:
    """Return a Supabase client that queries as the user who owns
    `access_token` (the JWT Supabase issued them at sign-in). RLS policies
    on `transactions` / `household_members` / `households` then apply
    exactly as they do for the browser app."""
    client = create_client(_setting("SUPABASE_URL"), _setting("SUPABASE_ANON_KEY"))
    client.postgrest.auth(access_token)
    return client


def get_user(access_token: str) -> dict | None:
    """{"id", "email"} of the user who owns `access_token`, verified by Supabase Auth (not
    just decoded), or None if the token is invalid or expired."""
    try:
        resp = create_client(_setting("SUPABASE_URL"), _setting("SUPABASE_ANON_KEY")).auth.get_user(access_token)
    except Exception:  # noqa: BLE001 — any auth failure means "not signed in"
        return None
    user = getattr(resp, "user", None)
    if not user or not getattr(user, "id", None):
        return None
    return {"id": user.id, "email": getattr(user, "email", None)}


def get_user_email(access_token: str) -> str | None:
    """The email of the user who owns `access_token`, or None if the token is invalid."""
    user = get_user(access_token)
    return user["email"] if user else None


def get_household_id(client: Client) -> str | None:
    """The signed-in user's household id, or None if they haven't joined
    one yet. Relies on RLS: this only ever returns a household the caller
    is actually a member of."""
    resp = (
        client.table("household_members")
        .select("household_id")
        .limit(1)
        .execute()
    )
    if not resp.data:
        return None
    return resp.data[0]["household_id"]
