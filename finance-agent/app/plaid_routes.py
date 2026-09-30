"""
Plaid bank connections: /api/plaid/link-token, /api/plaid/exchange, /api/plaid/sync.

Same shape as /api/chat: the browser sends its Supabase access token in the body, Supabase
Auth verifies it, and every database call goes through a client scoped to that user's JWT,
so RLS (supabase/schema.sql, migration 2026-09-29) keeps each household to its own items
and queue. No service-role key.

Synced transactions land in plaid_review_queue, never directly in transactions.

A Plaid access_token exists in plaintext only in memory, within one request: straight from
Plaid in exchange (encrypted before it's stored), or decrypted in _sync_item just before the
Plaid call. It's never logged or returned. Responses carry item ids, institution names and
counts only.
"""

import logging

from fastapi import APIRouter, HTTPException

from .plaid_categories import suggest_category
from .plaid_client import PlaidError, PlaidNotConfigured, plaid_client_from_env
from .schemas import (ExchangeResponse, ItemSyncResult, LinkTokenResponse, PlaidAuthRequest,
                      PlaidExchangeRequest, PlaidSyncRequest, SyncResponse)
from .supabase_client import client_for_user, get_household_id, get_user
from .token_crypto import TokenCryptoError, decrypt_token, encrypt_token, key_configured

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/plaid")

# Plaid asks callers to restart a paginated sync from its first cursor when this happens.
MUTATION_DURING_PAGINATION = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"
SYNC_ATTEMPTS = 3
UPSERT_CHUNK = 500


def plaid_ready() -> bool:
    try:
        plaid_client_from_env()
    except PlaidNotConfigured:
        return False
    return key_configured()


def _plaid():
    try:
        client = plaid_client_from_env()
    except PlaidNotConfigured as exc:
        raise HTTPException(status_code=503, detail=f"Bank connections aren't enabled yet: {exc}.") from None
    if not key_configured():
        raise HTTPException(status_code=503, detail="Bank connections aren't enabled yet: set PLAID_TOKEN_ENCRYPTION_KEY.")
    return client


def _caller(access_token: str):
    """(user, user-scoped Supabase client, household_id), or 401 / 403."""
    user = get_user(access_token)
    if user is None:
        raise HTTPException(status_code=401, detail="Your session has expired. Sign in again.")
    supabase = client_for_user(access_token)
    household_id = get_household_id(supabase)
    if household_id is None:
        raise HTTPException(status_code=403, detail="No household found for this user — join or create one first.")
    return user, supabase, household_id


def _plaid_http_error(exc: PlaidError) -> HTTPException:
    # Plaid's code and message are safe to show (they never echo a token). A 400 from Plaid
    # means the request was bad (e.g. an expired public_token); anything else is upstream.
    return HTTPException(status_code=400 if exc.status == 400 else 502, detail=f"Plaid {exc.error_code}: {exc}")


@router.post("/link-token", response_model=LinkTokenResponse)
def link_token(req: PlaidAuthRequest) -> LinkTokenResponse:
    plaid = _plaid()
    user, _, _ = _caller(req.access_token)
    try:
        data = plaid.link_token_create(client_user_id=user["id"])
    except PlaidError as exc:
        raise _plaid_http_error(exc) from None
    return LinkTokenResponse(link_token=data["link_token"], expiration=data.get("expiration"))


@router.post("/exchange", response_model=ExchangeResponse)
def exchange(req: PlaidExchangeRequest) -> ExchangeResponse:
    plaid = _plaid()
    user, supabase, household_id = _caller(req.access_token)
    try:
        data = plaid.item_public_token_exchange(req.public_token)
    except PlaidError as exc:
        raise _plaid_http_error(exc) from None
    plaid_token, item_id = data["access_token"], data["item_id"]

    institution_name = None
    try:  # a nicety for display; a failure here shouldn't lose the link
        institution_id = (plaid.item_get(plaid_token).get("item") or {}).get("institution_id")
        if institution_id:
            institution_name = plaid.institution_name(institution_id)
    except PlaidError as exc:
        log.warning("Plaid institution lookup failed for item %s: %s", item_id, exc.error_code)

    try:
        supabase.table("plaid_items").insert({
            "household_id": household_id,
            "access_token": encrypt_token(plaid_token),
            "item_id": item_id,
            "institution_name": institution_name,
            "linked_by": user["id"],
        }).execute()
    except Exception:
        # Don't leave a live bank connection at Plaid that nothing here knows about.
        log.exception("Saving Plaid item %s failed; removing it at Plaid", item_id)
        try:
            plaid.item_remove(plaid_token)
        except PlaidError as exc:
            log.warning("Plaid item_remove failed for item %s: %s", item_id, exc.error_code)
        raise HTTPException(status_code=500, detail="Couldn't save the bank connection, so it wasn't kept. Try linking again.") from None

    return ExchangeResponse(item_id=item_id, institution_name=institution_name)


def _queue_row(household_id: str, txn: dict) -> dict:
    """One plaid_review_queue row. Plaid amounts are positive for money out."""
    amount = float(txn["amount"])
    txn_type = "expense" if amount > 0 else "income"
    return {
        "household_id": household_id,
        "plaid_transaction_id": txn["transaction_id"],
        "suggested_category": suggest_category(txn.get("personal_finance_category"), txn_type),
        "amount": round(abs(amount), 2),
        "date": txn["date"],
        "merchant_name": txn.get("merchant_name") or txn.get("name"),
        "type": txn_type,
        "raw_plaid_data": txn,
    }


def _pull(plaid, plaid_token: str, start_cursor: str | None):
    """Every page of /transactions/sync from start_cursor: (added, modified, removed, cursor)."""
    for attempt in range(SYNC_ATTEMPTS):
        cursor, added, modified, removed = start_cursor, [], [], []
        try:
            while True:
                page = plaid.transactions_sync(plaid_token, cursor)
                added += page.get("added", [])
                modified += page.get("modified", [])
                removed += page.get("removed", [])
                cursor = page["next_cursor"]
                if not page.get("has_more"):
                    return added, modified, removed, cursor
        except PlaidError as exc:
            if exc.error_code != MUTATION_DURING_PAGINATION or attempt == SYNC_ATTEMPTS - 1:
                raise
    raise AssertionError("unreachable")


def _sync_item(plaid, supabase, household_id: str, item: dict) -> ItemSyncResult:
    result = ItemSyncResult(item_id=item["item_id"], institution_name=item.get("institution_name"), status="ok")
    added, modified, removed, cursor = _pull(plaid, decrypt_token(item["access_token"]), item.get("cursor"))

    # Pending transactions are skipped: Plaid removes each one and adds a posted version with a
    # new id when it clears, so queueing both would put the same purchase up for review twice.
    rows = {}
    for txn in added + modified:
        if txn.get("pending"):
            result.skipped_pending += 1
        elif float(txn.get("amount") or 0) != 0:
            rows[txn["transaction_id"]] = _queue_row(household_id, txn)
    rows = list(rows.values())
    # Upsert: re-running a sync (say the cursor save below failed) can't duplicate a row, and
    # "modified" updates the row in place. `reviewed` isn't sent, so a reviewed row stays so.
    for i in range(0, len(rows), UPSERT_CHUNK):
        supabase.table("plaid_review_queue").upsert(
            rows[i:i + UPSERT_CHUNK], on_conflict="household_id,plaid_transaction_id").execute()
    result.queued = len(rows)

    removed_ids = [r["transaction_id"] for r in removed if r.get("transaction_id")]
    if removed_ids:
        resp = (supabase.table("plaid_review_queue").delete()
                .eq("household_id", household_id).eq("reviewed", False)
                .in_("plaid_transaction_id", removed_ids).execute())
        result.removed = len(resp.data or [])

    # Last, so a failure anywhere above leaves the cursor where it was and the next sync
    # fetches the same changes again.
    supabase.table("plaid_items").update({"cursor": cursor}).eq("id", item["id"]).execute()
    return result


@router.post("/sync", response_model=SyncResponse)
def sync(req: PlaidSyncRequest) -> SyncResponse:
    plaid = _plaid()
    _, supabase, household_id = _caller(req.access_token)
    query = (supabase.table("plaid_items")
             .select("id,item_id,institution_name,access_token,cursor")
             .eq("household_id", household_id))
    if req.item_id:
        query = query.eq("item_id", req.item_id)
    items = query.execute().data or []
    if req.item_id and not items:
        raise HTTPException(status_code=404, detail="No such bank connection in your household.")

    results = []
    for item in items:
        # One bank needing attention (say ITEM_LOGIN_REQUIRED) mustn't stop the others syncing.
        try:
            results.append(_sync_item(plaid, supabase, household_id, item))
        except PlaidError as exc:
            log.warning("Plaid sync failed for item %s: %s", item["item_id"], exc.error_code)
            results.append(ItemSyncResult(item_id=item["item_id"], institution_name=item.get("institution_name"),
                                          status="error", error_code=exc.error_code))
        except TokenCryptoError:
            log.error("Stored token for item %s can't be decrypted with the current key", item["item_id"])
            results.append(ItemSyncResult(item_id=item["item_id"], institution_name=item.get("institution_name"),
                                          status="error", error_code="TOKEN_UNREADABLE"))
    return SyncResponse(items=results)
