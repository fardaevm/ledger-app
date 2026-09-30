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
