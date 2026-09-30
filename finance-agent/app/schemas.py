from typing import Literal

from pydantic import BaseModel, Field

# Size caps: every character here is sent to the model on the owner's Anthropic key, so a
# single request can't be made arbitrarily large.
MAX_MESSAGE_CHARS = 4000
MAX_HISTORY_MESSAGES = 40


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=MAX_MESSAGE_CHARS * 2)


class ChatRequest(BaseModel):
    access_token: str = Field(max_length=8000)  # the Supabase JWT from the signed-in user's browser session
    message: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    history: list[ChatMessage] = Field(default=[], max_length=MAX_HISTORY_MESSAGES)


class ToolCallTrace(BaseModel):
    name: str
    input: dict
    output: dict


class ChatResponse(BaseModel):
    reply: str
    tool_calls: list[ToolCallTrace] = []


# --- Plaid (/api/plaid/*). The Supabase JWT travels in the body, as for /api/chat. ---

class PlaidAuthRequest(BaseModel):
    access_token: str = Field(max_length=8000)


class PlaidExchangeRequest(PlaidAuthRequest):
    public_token: str = Field(min_length=1, max_length=200)  # from Plaid Link's onSuccess


class PlaidSyncRequest(PlaidAuthRequest):
    item_id: str | None = Field(default=None, max_length=200)  # one item; omitted = all of the household's


class LinkTokenResponse(BaseModel):
    link_token: str
    expiration: str | None = None


class ExchangeResponse(BaseModel):
    item_id: str
    institution_name: str | None = None


class ItemSyncResult(BaseModel):
    item_id: str
    institution_name: str | None = None
    status: Literal["ok", "error"]
    queued: int = 0             # added or updated in plaid_review_queue
    removed: int = 0            # unreviewed queue rows Plaid withdrew
    skipped_pending: int = 0    # pending bank transactions: they'll come back once posted
    error_code: str | None = None


class SyncResponse(BaseModel):
    items: list[ItemSyncResult]
