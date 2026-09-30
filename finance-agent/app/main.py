"""
HTTP layer for the finance assistant.

Deployed as a Vercel Python function inside the ledger-app project (see api/index.py and
vercel.json), so the browser calls it on the SAME origin as the app: /api/chat, /api/health.
Locally, uvicorn serves the same /api paths and Vite's dev server proxies /api to it.
"""

import os

from dotenv import load_dotenv

load_dotenv()

from fastapi import APIRouter, FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from . import agent  # noqa: E402
from .plaid_routes import plaid_ready, router as plaid_router  # noqa: E402
from .schemas import ChatRequest, ChatResponse, ToolCallTrace  # noqa: E402
from .supabase_client import client_for_user, get_household_id, get_user_email  # noqa: E402

app = FastAPI(title="Ledger finance assistant")

# Same-origin requests (the deployed app, or the app through Vite's proxy) need no CORS at
# all. Only list extra origins here if something else must call the API from a browser.
# Unset means none: never "*".
allowed_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_methods=["POST"],
        allow_headers=["*"],
    )


def allowed_emails() -> set[str]:
    """Who may use the assistant. Sign-up in ledger-app is open, so without this anyone could
    create an account and run up the Anthropic bill. Closed by default: an unset list lets
    nobody in."""
    raw = os.environ.get("ASSISTANT_ALLOWED_EMAILS", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def assistant_ready() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY")) and bool(allowed_emails())


router = APIRouter(prefix="/api")


@router.post("/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    allowed = allowed_emails()
    if not allowed:
        raise HTTPException(status_code=503, detail="The assistant isn't enabled yet: set ASSISTANT_ALLOWED_EMAILS.")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(status_code=503, detail="The assistant isn't enabled yet: set ANTHROPIC_API_KEY.")

    email = get_user_email(req.access_token)
    if email is None:
        raise HTTPException(status_code=401, detail="Your session has expired. Sign in again.")
    if email.lower() not in allowed:
        raise HTTPException(status_code=403, detail="The assistant isn't available for this account.")

    supabase = client_for_user(req.access_token)
    household_id = get_household_id(supabase)
    if household_id is None:
        raise HTTPException(status_code=403, detail="No household found for this user — join or create one first.")

    result = agent.run_agent(
        supabase_client=supabase,
        household_id=household_id,
        history=[m.model_dump() for m in req.history],
        user_message=req.message,
    )

    return ChatResponse(
        reply=result.reply,
        tool_calls=[ToolCallTrace(name=t.name, input=t.input, output=t.output) for t in result.tool_calls],
    )


@router.get("/health")
def health() -> dict:
    # assistant_ready / plaid_ready say whether the settings /api/chat and /api/plaid/* need
    # are present (never their values), so a deploy can be checked from the browser.
    return {"status": "ok", "assistant_ready": assistant_ready(), "plaid_ready": plaid_ready()}


app.include_router(router)
app.include_router(plaid_router)
