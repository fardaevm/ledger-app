"""
The agent loop: send the conversation + tool schemas to Claude, execute
whichever tools it asks for, feed the results back, repeat until it
answers in plain text.

This is written by hand (no LangGraph/CrewAI) on purpose for v1 — see the
project README for why. Swap in a framework later without changing
tools.py at all; that's the point of keeping tool logic separate from the
loop that calls it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import anthropic

from . import tools

# The cheapest tier is enough here: every number comes from a tool, so the model only picks
# tools and phrases the answer.
MODEL = "claude-haiku-4-5-20251001"
MAX_TOOL_ITERATIONS = 6


def build_system_prompt(today: date | None = None) -> str:
    """Built per request, not once at import: on a long-running server a date baked in at
    start-up would go stale after midnight."""
    return f"""You are a family finance assistant embedded in a shared \
household ledger app. Today's date is {(today or date.today()).isoformat()}.

Ground rules:
- Never state a specific number (a total, an average, a trend, a percent \
change) unless it came from a tool call in this conversation. If you \
haven't called a tool for it yet, call one before answering.
- Don't do arithmetic yourself for anything that matters — the tools \
return correct sums; trust them over your own mental math.
- When giving savings or budgeting advice, ground it in the household's \
actual numbers (pull them via tools first), not generic personal-finance \
platitudes.
- State the date range you're describing when you report a number, so \
it's clear what period a claim covers.
- detect_recurring_charges is a heuristic — present its results as \
candidates to review, not certainties.
- Keep responses concise and skimmable: short paragraphs or a tight \
bullet list, not a financial essay.
- Replies appear in a narrow chat panel, as narrow as a phone screen. Use \
only short paragraphs, bullet or numbered lists and **bold**: no tables, no \
headings. For several debts or categories, one bullet each.

Talking about debt (the same tone rules as the app's Debts page):
- Lead with progress made: how much has been paid off and the percent \
paid off (from get_debts), before anything about what's left.
- Never state a bare "you owe $X". When you give a remaining balance, give \
it with its context: how much is already paid off, or the progress \
percent, or the payoff estimate.
- Debt that's being paid down on schedule is normal, not a problem. Don't \
use alarming language about it ("drowning", "crushing", "dangerous", \
"behind", "worrying") and don't moralise.
- Only raise concern for a real problem the tools show, and say it calmly \
with the number: minimum_covers_interest is false (paying only the minimum \
never brings the balance down), or a balance that has grown. Nothing else \
is a problem: a high interest rate or a large balance is a fact for \
deciding what to pay first, so don't call it a "concern", a "problem" or a \
"worry", or say it's costing "meaningful" interest. Give the number instead.
- Payoff dates: say which basis you're quoting. rough_estimate is the \
Debts page's own figure (minimum payments, interest ignored); with_interest \
is the more realistic month-by-month projection. Don't present either as \
certain.
- "Which should we pay off first?": call debt_payoff_comparison and reason \
from its numbers (rates, balances, projected interest). Present it as a \
choice with trade-offs, not an order.
- For recurring rules use get_recurring_rules (exact); for the profit goal \
use profit_goal_status (the same numbers as the Dashboard's goal ring).
"""


@dataclass
class ToolCallLog:
    name: str
    input: dict[str, Any]
    output: dict[str, Any]


@dataclass
class AgentResult:
    reply: str
    tool_calls: list[ToolCallLog] = field(default_factory=list)


def _client() -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


def run_agent(supabase_client, household_id: str, history: list[dict[str, str]],
              user_message: str) -> AgentResult:
    """
    history: prior turns as [{"role": "user"|"assistant", "content": str}, ...]
    Returns the assistant's reply plus a trace of every tool call made,
    so the caller can log/display it (useful now for debugging, and later
    for the observability step in the project roadmap).
    """
    client = _client()
    messages: list[dict[str, Any]] = [*history, {"role": "user", "content": user_message}]
    tool_log: list[ToolCallLog] = []
    system_prompt = build_system_prompt()

    for _ in range(MAX_TOOL_ITERATIONS):
        response = client.messages.create(
            model=MODEL,
            max_tokens=1024,
            system=system_prompt,
            tools=tools.TOOL_SCHEMAS,
            messages=messages,
        )

        if response.stop_reason != "tool_use":
            final_text = "".join(
                block.text for block in response.content if block.type == "text"
            )
            return AgentResult(reply=final_text, tool_calls=tool_log)

        # Model wants to call one or more tools — execute each, collect results
        messages.append({"role": "assistant", "content": response.content})
        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            impl = tools.TOOL_IMPLEMENTATIONS.get(block.name)
            if impl is None:
                output: dict[str, Any] = {"error": f"unknown tool {block.name}"}
            else:
                try:
                    output = impl(supabase_client, household_id, **block.input)
                except Exception as exc:  # noqa: BLE001 — surface any failure to the model, not a 500
                    output = {"error": str(exc)}

            tool_log.append(ToolCallLog(name=block.name, input=block.input, output=output))
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": str(output),
            })

        messages.append({"role": "user", "content": tool_results})

    return AgentResult(
        reply="I wasn't able to finish that within my tool-call budget — try breaking the question into a smaller piece.",
        tool_calls=tool_log,
    )
