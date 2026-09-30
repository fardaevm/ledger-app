"""
Tool definitions (Anthropic tool-use schemas) + their implementations.

Design rule this file exists to enforce: the model never computes a sum,
average, or trend itself — every number it states comes from here. This
keeps the assistant's financial claims checkable and testable, which is
the whole point of separating "tools" from "the model."

Every function takes a Supabase client already scoped to the caller (see
supabase_client.client_for_user) and the caller's household_id, and
returns a plain JSON-serializable dict — never raw transaction rows with
more detail than the question needs.
"""

from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, datetime
from typing import Any


# ---------------------------------------------------------------------------
# Tool schemas — passed to the Anthropic API as `tools`
# ---------------------------------------------------------------------------

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "get_transactions",
        "description": (
            "Fetch individual transactions for the household within a date "
            "range, optionally filtered by type and/or category. Use this "
            "when the user wants specific line items (e.g. 'what did I buy "
            "at Whole Foods last week'), not for totals — use "
            "spending_summary or spending_by_category for aggregates, "
            "since those are cheaper and less likely to hit the limit."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "ISO date YYYY-MM-DD, inclusive"},
                "end_date": {"type": "string", "description": "ISO date YYYY-MM-DD, inclusive"},
                "type": {"type": "string", "enum": ["income", "expense"], "description": "Omit for both"},
                "category": {"type": "string", "description": "Exact category name, omit for all categories"},
                "limit": {"type": "integer", "default": 50, "description": "Max rows to return"},
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "spending_summary",
        "description": (
            "Total income, expenses, and profit for the household over a "
            "date range. Use this for any question about how much was "
            "earned, spent, or saved over a period."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "ISO date YYYY-MM-DD, inclusive"},
                "end_date": {"type": "string", "description": "ISO date YYYY-MM-DD, inclusive"},
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "spending_by_category",
        "description": (
            "Breaks down income or expenses by category over a date range, "
            "sorted highest to lowest. Use this for 'where is the money "
            "going' / 'what's our biggest expense' type questions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "start_date": {"type": "string", "description": "ISO date YYYY-MM-DD, inclusive"},
                "end_date": {"type": "string", "description": "ISO date YYYY-MM-DD, inclusive"},
                "type": {"type": "string", "enum": ["income", "expense"], "default": "expense"},
            },
            "required": ["start_date", "end_date"],
        },
    },
    {
        "name": "compare_periods",
        "description": (
            "Compares income/expense/profit totals between two date "
            "ranges of your choosing (e.g. this month vs last month, this "
            "quarter vs last quarter) and returns the dollar and percent "
            "change for each. Use this for any 'are we doing better/worse "
            "than X' question."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period_a_start": {"type": "string"},
                "period_a_end": {"type": "string"},
                "period_b_start": {"type": "string"},
                "period_b_end": {"type": "string"},
            },
            "required": ["period_a_start", "period_a_end", "period_b_start", "period_b_end"],
        },
    },
    {
        "name": "detect_recurring_charges",
        "description": (
            "Looks over roughly the last 4 months of expenses and flags "
            "likely recurring charges (subscriptions, rent, etc.) — same "
            "category and a similar amount appearing in two or more "
            "different months. This is a heuristic, not a guarantee — say "
            "so when presenting results."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "as_of_date": {
                    "type": "string",
                    "description": "ISO date to look back from; defaults to today if omitted",
                }
            },
        },
    },
    {
        "name": "get_debts",
        "description": (
            "Lists every debt the household is tracking (credit cards, loans, mortgages): "
            "name, type, original balance, current balance, interest rate (APR %) and "
            "minimum monthly payment, plus how much of each is already paid off and the "
            "household totals, computed exactly as the Debts page shows them. Call this "
            "before saying anything about debts, and to get the numbers for "
            "debt_payoff_projection."
        ),
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "debt_payoff_projection",
        "description": (
            "Payoff projection for one debt, from its current balance, minimum payment and "
            "interest rate (take these from get_debts; never invent them). Returns the "
            "Debts page's own 'rough estimate' (months = balance / minimum, interest "
            "ignored) and the interest per month right now, plus a separate month-by-month "
            "projection with interest (months, payoff month, total interest). When you quote "
            "a date, say which basis it's on."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "current_balance": {"type": "number"},
                "minimum_payment": {"type": "number", "description": "Omit if the debt has none"},
                "interest_rate": {"type": "number", "description": "APR in percent, e.g. 24.99. Omit if unknown"},
                "as_of_date": {"type": "string", "description": "ISO date the projection starts from; defaults to today"},
            },
            "required": ["current_balance"],
        },
    },
    {
        "name": "debt_payoff_comparison",
        "description": (
            "Runs debt_payoff_projection for two of the household's debts (by name) and "
            "returns them side by side, with factual comparisons (which has the higher "
            "interest rate, the smaller balance, the larger interest cost). Use this for "
            "'which should we pay off first' questions and reason from its numbers."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "debt_a": {"type": "string", "description": "Debt name as listed by get_debts"},
                "debt_b": {"type": "string", "description": "Debt name as listed by get_debts"},
                "as_of_date": {"type": "string", "description": "ISO date the projections start from; defaults to today"},
            },
            "required": ["debt_a", "debt_b"],
        },
    },
    {
        "name": "get_recurring_rules",
        "description": (
            "Lists the household's active recurring rules (rent, salary, subscriptions the "
            "app adds automatically each month): name, category, income/expense, amount, "
            "day of month and the next date it will be added. Prefer this over "
            "detect_recurring_charges when asking what's scheduled; these are exact rules, "
            "not a guess."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "as_of_date": {"type": "string", "description": "ISO date to compute the next occurrence from; defaults to today"},
            },
        },
    },
    {
        "name": "profit_goal_status",
        "description": (
            "Profit so far this period against the household's profit goal: the same "
            "numbers as the goal ring on the Dashboard. The goal is the custom one if set, "
            "otherwise the average profit of earlier periods, otherwise a $3,000/month "
            "default. Returns which of those applies."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period": {"type": "string", "enum": ["monthly", "annual"], "default": "monthly"},
                "as_of_date": {"type": "string", "description": "ISO date inside the period to report; defaults to today"},
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Implementations
# ---------------------------------------------------------------------------


def _fetch_transactions(client, household_id: str, start_date: str, end_date: str,
                         type_: str | None = None, category: str | None = None,
                         limit: int | None = None) -> list[dict]:
    q = (
        client.table("transactions")
        .select("id, type, amount, date, category, note, author_email")
        .eq("household_id", household_id)
        .gte("date", start_date)
        .lte("date", end_date)
        .order("date", desc=True)
    )
    if type_:
        q = q.eq("type", type_)
    if category:
        q = q.eq("category", category)
    if limit:
        q = q.limit(limit)
    return q.execute().data or []


def get_transactions(client, household_id: str, start_date: str, end_date: str,
                      type: str | None = None, category: str | None = None,
                      limit: int = 50) -> dict:
    rows = _fetch_transactions(client, household_id, start_date, end_date, type, category, limit)
    return {
        "start_date": start_date,
        "end_date": end_date,
        "count": len(rows),
        "transactions": [
            {
                "date": r["date"],
                "type": r["type"],
                "amount": float(r["amount"]),
                "category": r["category"],
                "note": r.get("note") or "",
                "added_by": (r.get("author_email") or "").split("@")[0],
            }
            for r in rows
        ],
    }


def spending_summary(client, household_id: str, start_date: str, end_date: str) -> dict:
    rows = _fetch_transactions(client, household_id, start_date, end_date, limit=5000)
    income = sum(float(r["amount"]) for r in rows if r["type"] == "income")
    expense = sum(float(r["amount"]) for r in rows if r["type"] == "expense")
    return {
        "start_date": start_date,
        "end_date": end_date,
        "income": round(income, 2),
        "expense": round(expense, 2),
        "profit": round(income - expense, 2),
        "transaction_count": len(rows),
    }


def spending_by_category(client, household_id: str, start_date: str, end_date: str,
                          type: str = "expense") -> dict:
    rows = _fetch_transactions(client, household_id, start_date, end_date, type_=type, limit=5000)
    totals: dict[str, float] = defaultdict(float)
    for r in rows:
        totals[r["category"]] += float(r["amount"])
    breakdown = sorted(
        ({"category": cat, "total": round(amt, 2)} for cat, amt in totals.items()),
        key=lambda x: x["total"],
        reverse=True,
    )
    return {
        "start_date": start_date,
        "end_date": end_date,
        "type": type,
        "total": round(sum(totals.values()), 2),
        "by_category": breakdown,
    }


def compare_periods(client, household_id: str, period_a_start: str, period_a_end: str,
                     period_b_start: str, period_b_end: str) -> dict:
    a = spending_summary(client, household_id, period_a_start, period_a_end)
    b = spending_summary(client, household_id, period_b_start, period_b_end)

    def delta(field: str) -> dict:
        diff = round(a[field] - b[field], 2)
        pct = round((diff / b[field]) * 100, 1) if b[field] else None
        return {"change": diff, "percent_change": pct}

    return {
        "period_a": a,
        "period_b": b,
        "income_delta": delta("income"),
        "expense_delta": delta("expense"),
        "profit_delta": delta("profit"),
    }


def detect_recurring_charges(client, household_id: str, as_of_date: str | None = None) -> dict:
    end = datetime.strptime(as_of_date, "%Y-%m-%d").date() if as_of_date else date.today()
    start = date(end.year - (1 if end.month <= 4 else 0), ((end.month - 4 - 1) % 12) + 1, 1)

    rows = _fetch_transactions(client, household_id, start.isoformat(), end.isoformat(),
                                type_="expense", limit=5000)

    # group by (category, amount rounded to nearest 5%) -> set of months it appeared in
    groups: dict[tuple[str, int], dict[str, Any]] = {}
    for r in rows:
        amt = float(r["amount"])
        key = (r["category"], round(amt, 0))  # bucket: category + whole-dollar amount
        month = r["date"][:7]  # YYYY-MM
        g = groups.setdefault(key, {"category": r["category"], "amounts": [], "months": set(), "notes": set()})
        g["amounts"].append(amt)
        g["months"].add(month)
        if r.get("note"):
            g["notes"].add(r["note"])

    recurring = []
    for (category, _amt_bucket), g in groups.items():
        if len(g["months"]) >= 2:
            avg = round(sum(g["amounts"]) / len(g["amounts"]), 2)
            recurring.append({
                "category": category,
                "approx_amount": avg,
                "months_seen": sorted(g["months"]),
                "sample_notes": sorted(g["notes"])[:3],
            })

    recurring.sort(key=lambda x: len(x["months_seen"]), reverse=True)
    return {
        "lookback_start": start.isoformat(),
        "lookback_end": end.isoformat(),
        "method": "heuristic: same category + same whole-dollar amount appearing in 2+ different months",
        "candidates": recurring,
    }


# ---------------------------------------------------------------------------
# Debts, recurring rules and the profit goal (tables ledger-app added after v1).
# These mirror the app's own calculations line for line (see the ledger-app
# function named in each docstring), so the assistant and the UI never disagree.
# ---------------------------------------------------------------------------

DEBT_TYPES = {"credit_card": "Credit card", "loan": "Loan", "mortgage": "Mortgage", "other": "Other"}
DEFAULT_MONTHLY_GOAL = 3000
MAX_PROJECTION_MONTHS = 1200  # 100 years: past this a "payoff date" means nothing


def _as_of(as_of_date: str | None) -> date:
    return datetime.strptime(as_of_date, "%Y-%m-%d").date() if as_of_date else date.today()


def _add_months(first_of_month: date, n: int) -> date:
    years, month0 = divmod(first_of_month.month - 1 + n, 12)
    return date(first_of_month.year + years, month0 + 1, 1)


def _js_round(x: float) -> int:
    """JavaScript's Math.round (halves round up), not Python's banker's rounding."""
    return math.floor(x + 0.5)


def _floor_pct(fraction: float, decimals: int = 0) -> float:
    """Percent rounded DOWN, like the Debts page (floorPct), so a milestone never shows
    before it's truly reached. 100 only at exactly 100."""
    pct = min(100.0, max(0.0, fraction * 100))
    if pct >= 100:
        return 100.0
    scale = 10 ** decimals
    # the tiny epsilon keeps float noise (e.g. 57.99999999) from rounding a whole number down
    return math.floor(pct * scale + 1e-9) / scale


def _money(x) -> float | None:
    return None if x is None else round(float(x), 2)


def get_debts(client, household_id: str) -> dict:
    """Mirrors renderDebts() / debtTotals() in ledger-app: per-debt paid off = original −
    current (never below 0), percent rounded down; household totals from the SUMS (never an
    average of per-debt percentages), percent to one decimal, rounded down."""
    rows = (
        client.table("debts")
        .select("id, name, debt_type, original_balance, current_balance, interest_rate, minimum_payment, created_at")
        .eq("household_id", household_id)
        .order("created_at")
        .execute()
        .data
        or []
    )
    debts = []
    for r in rows:
        original = float(r["original_balance"])
        current = float(r["current_balance"])
        paid = max(0.0, original - current)
        debts.append({
            "name": r["name"],
            "type": DEBT_TYPES.get(r["debt_type"], "Other"),
            "original_balance": round(original, 2),
            "current_balance": round(current, 2),
            "interest_rate": None if r.get("interest_rate") is None else float(r["interest_rate"]),
            "minimum_payment": _money(r.get("minimum_payment")),
            "paid_off": round(paid, 2),
            "percent_paid_off": int(_floor_pct(paid / original)) if original > 0 else 0,
            "is_paid_off": current <= 0,
        })
    total_original = sum(d["original_balance"] for d in debts)
    total_current = sum(d["current_balance"] for d in debts)
    total_paid = max(0.0, total_original - total_current)
    return {
        "count": len(debts),
        "debts": debts,
        "totals": {
            "original_balance": round(total_original, 2),
            "current_balance": round(total_current, 2),
            "paid_off": round(total_paid, 2),
            "percent_paid_off": _floor_pct(total_paid / total_original, 1) if total_original > 0 else 0.0,
        },
    }


def _with_interest(balance: float, payment: float, apr: float, start: date) -> dict:
    """Month-by-month at the minimum payment: each month adds balance × APR/12 of interest,
    then the payment comes off. An estimate (card issuers usually compound daily)."""
    rate = apr / 100 / 12
    if balance * rate >= payment:
        return {
            "pays_off": False,
            "reason": "The minimum payment doesn't cover the monthly interest, so paying only the minimum never brings the balance down.",
        }
    remaining, interest_total, months = balance, 0.0, 0
    while remaining > 0.005 and months < MAX_PROJECTION_MONTHS:
        interest = remaining * rate
        interest_total += interest
        remaining = remaining + interest - payment
        months += 1
    payoff = _add_months(start, months)
    return {
        "pays_off": True,
        "months": months,
        "payoff_month": payoff.strftime("%Y-%m"),
        "payoff_month_label": payoff.strftime("%B %Y"),
        "total_interest": round(interest_total, 2),
        "total_paid": round(balance + interest_total, 2),
        "basis": "minimum payments with interest added monthly at APR/12 (an estimate; issuers often compound daily)",
    }


def debt_payoff_projection(client, household_id: str, current_balance: float,
                           minimum_payment: float | None = None, interest_rate: float | None = None,
                           as_of_date: str | None = None) -> dict:
    """The rough estimate mirrors payoffEstimate() in ledger-app exactly: months =
    ceil(balance ÷ minimum), payoff = first of this month + that many months, and
    monthly interest = balance × APR / 100 / 12 (with the same 'won't go down' check)."""
    balance = float(current_balance)
    minimum = float(minimum_payment) if minimum_payment else 0.0
    apr = None if interest_rate is None else float(interest_rate)
    start = _as_of(as_of_date).replace(day=1)
    result: dict[str, Any] = {
        "current_balance": round(balance, 2),
        "minimum_payment": minimum or None,
        "interest_rate": apr,
    }
    if balance <= 0:
        return {**result, "status": "paid_off"}
    if minimum <= 0:
        return {**result, "status": "no_minimum_payment",
                "note": "No minimum payment is set, so there's no payoff estimate (the Debts page says the same)."}

    months = math.ceil(balance / minimum)
    payoff = _add_months(start, months)
    result["status"] = "paying_down"
    result["rough_estimate"] = {
        "months": months,
        "payoff_month": payoff.strftime("%Y-%m"),
        "payoff_month_label": payoff.strftime("%B %Y"),
        "basis": "balance ÷ minimum payment, interest ignored: exactly the Debts page's 'Rough estimate'",
    }
    if apr:
        monthly_interest = balance * apr / 100 / 12
        result["monthly_interest_now"] = round(monthly_interest, 2)
        result["minimum_covers_interest"] = monthly_interest < minimum
        result["with_interest"] = _with_interest(balance, minimum, apr, start)
    else:
        result["monthly_interest_now"] = 0.0 if apr == 0 else None
        result["with_interest"] = None
        result["note"] = ("No interest rate is on file, so the rough estimate is the only projection."
                          if apr is None else "0% APR: the rough estimate is exact.")
    return result


def _find_debt(debts: list[dict], name: str) -> dict:
    wanted = name.strip().lower()
    exact = [d for d in debts if d["name"].lower() == wanted]
    partial = [d for d in debts if wanted in d["name"].lower()]
    matches = exact or partial
    if len(matches) != 1:
        names = ", ".join(d["name"] for d in debts) or "none"
        problem = "No debt matches" if not matches else "More than one debt matches"
        raise ValueError(f'{problem} "{name}". The household\'s debts are: {names}.')
    return matches[0]


def debt_payoff_comparison(client, household_id: str, debt_a: str, debt_b: str,
                           as_of_date: str | None = None) -> dict:
    debts = get_debts(client, household_id)["debts"]
    a, b = _find_debt(debts, debt_a), _find_debt(debts, debt_b)
    sides = []
    for d in (a, b):
        sides.append({
            **d,
            "projection": debt_payoff_projection(
                client, household_id, d["current_balance"], d["minimum_payment"], d["interest_rate"], as_of_date
            ),
        })

    def which(key: str, pick) -> str | None:
        va, vb = key(sides[0]), key(sides[1])
        if va is None or vb is None or va == vb:
            return None
        return sides[0]["name"] if pick(va, vb) else sides[1]["name"]

    def interest_cost(s):
        w = s["projection"].get("with_interest")
        return w["total_interest"] if w and w.get("pays_off") else None

    return {
        "debts": sides,
        "facts": {
            "higher_interest_rate": which(lambda s: s["interest_rate"], lambda x, y: x > y),
            "smaller_balance": which(lambda s: s["current_balance"], lambda x, y: x < y),
            "larger_projected_interest_cost": which(interest_cost, lambda x, y: x > y),
        },
        "strategies": (
            "Paying the higher interest rate first ('avalanche') minimises total interest; "
            "clearing the smaller balance first ('snowball') frees up a payment sooner. "
            "Minimums on every debt still get paid either way."
        ),
    }


def get_recurring_rules(client, household_id: str, as_of_date: str | None = None) -> dict:
    """Active rules only. Next occurrence mirrors nextRunDate() in ledger-app: this month if
    the day hasn't come yet, otherwise next month (days only go up to 28, so it always exists)."""
    today = _as_of(as_of_date)
    rows = (
        client.table("recurring_rules")
        .select("id, type, amount, category, note, day_of_month, active")
        .eq("household_id", household_id)
        .eq("active", True)
        .order("day_of_month")
        .execute()
        .data
        or []
    )
    rules = []
    for r in sorted(rows, key=lambda r: r["day_of_month"]):
        day = int(r["day_of_month"])
        nxt = date(today.year, today.month, day) if day > today.day else _add_months(today.replace(day=1), 1).replace(day=day)
        rules.append({
            "name": (r.get("note") or "").strip() or r["category"],  # the app shows the note, else the category
            "category": r["category"],
            "type": r["type"],
            "amount": round(float(r["amount"]), 2),
            "day_of_month": day,
            "next_occurrence": nxt.isoformat(),
        })
    return {"as_of": today.isoformat(), "count": len(rules), "rules": rules}


def profit_goal_status(client, household_id: str, period: str = "monthly",
                       as_of_date: str | None = None) -> dict:
    """Mirrors renderRings() / profitGoal() / automaticGoal() on the Dashboard, including
    that the app works from the household's newest 1,000 transactions: custom goal if set
    (×12 for annual), else the average profit of earlier periods that have entries if that
    average is positive, else $3,000/month. Percent uses JavaScript rounding, like the ring."""
    today = _as_of(as_of_date)
    monthly = period != "annual"
    key_len = 7 if monthly else 4
    selected = today.isoformat()[:key_len]

    rows = (
        client.table("transactions")
        .select("type, amount, date")
        .eq("household_id", household_id)
        .order("date", desc=True)
        .limit(1000)
        .execute()
        .data
        or []
    )
    signed = lambda r: (1 if r["type"] == "income" else -1) * float(r["amount"])  # noqa: E731
    income = sum(float(r["amount"]) for r in rows if r["date"][:key_len] == selected and r["type"] == "income")
    expense = sum(float(r["amount"]) for r in rows if r["date"][:key_len] == selected and r["type"] == "expense")
    profit = income - expense

    earlier: dict[str, float] = defaultdict(float)
    for r in rows:
        key = r["date"][:key_len]
        if key < selected:
            earlier[key] += signed(r)

    household = client.table("households").select("*").eq("id", household_id).limit(1).execute().data or []
    override = float(household[0].get("profit_goal_override") or 0) if household else 0.0
    average = sum(earlier.values()) / len(earlier) if earlier else 0.0
    if override > 0:
        goal, source = override * (1 if monthly else 12), "custom"
    elif average > 0:
        goal, source = average, "average of earlier periods"
    else:
        goal, source = DEFAULT_MONTHLY_GOAL * (1 if monthly else 12), "default"

    progress = profit / goal
    return {
        "period": selected,
        "period_type": "monthly" if monthly else "annual",
        "income": round(income, 2),
        "expense": round(expense, 2),
        "profit": round(profit, 2),
        "goal": round(goal, 2),
        "goal_display": _js_round(goal),  # the ring shows whole dollars: "of $3,475 goal"
        "goal_source": source,
        "earlier_periods_averaged": len(earlier) if source != "custom" else None,
        "percent_of_goal": _js_round(progress * 100),  # exactly the ring's label (can be negative)
        "ring_fill_percent": min(100, max(0, _js_round(progress * 100))),  # the ring never draws past full or below empty
    }


TOOL_IMPLEMENTATIONS = {
    "get_transactions": get_transactions,
    "spending_summary": spending_summary,
    "spending_by_category": spending_by_category,
    "compare_periods": compare_periods,
    "detect_recurring_charges": detect_recurring_charges,
    "get_debts": get_debts,
    "debt_payoff_projection": debt_payoff_projection,
    "debt_payoff_comparison": debt_payoff_comparison,
    "get_recurring_rules": get_recurring_rules,
    "profit_goal_status": profit_goal_status,
}
