"""
Unit tests for the deterministic tool functions in app/tools.py.

These use a fake Supabase client (a tiny stand-in implementing the same
chained-call interface) so the tests run with no network and no real
project — fast enough to run on every change, which is the point.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import tools  # noqa: E402


class FakeQuery:
    """Mimics the chainable .select().eq().gte()... interface just enough
    for tools.py to work against, backed by an in-memory list of rows."""

    def __init__(self, rows):
        self._rows = rows

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, field, value):
        self._rows = [r for r in self._rows if r.get(field) == value]
        return self

    def gte(self, field, value):
        self._rows = [r for r in self._rows if r[field] >= value]
        return self

    def lte(self, field, value):
        self._rows = [r for r in self._rows if r[field] <= value]
        return self

    def order(self, *_args, **_kwargs):
        return self

    def limit(self, n):
        self._rows = self._rows[:n]
        return self

    def execute(self):
        class Resp:
            pass
        resp = Resp()
        resp.data = self._rows
        return resp


class FakeClient:
    """`rows` backs the transactions table (and any table not named in `tables`), so the
    original single-list tests keep working; `tables` adds debts, recurring_rules, etc."""

    def __init__(self, rows, tables=None):
        self._rows = rows
        self._tables = tables or {}

    def table(self, name):
        return FakeQuery(list(self._tables.get(name, self._rows)))


SAMPLE_ROWS = [
    {"id": "1", "type": "income", "amount": 5000, "date": "2026-08-01", "category": "Salary", "note": "", "author_email": "ali@x.com", "household_id": "h1"},
    {"id": "2", "type": "expense", "amount": 1500, "date": "2026-08-03", "category": "Rent & Housing", "note": "", "author_email": "ali@x.com", "household_id": "h1"},
    {"id": "3", "type": "expense", "amount": 200, "date": "2026-08-10", "category": "Groceries", "note": "", "author_email": "sara@x.com", "household_id": "h1"},
    {"id": "4", "type": "expense", "amount": 15, "date": "2026-08-15", "category": "Subscriptions", "note": "Netflix", "author_email": "ali@x.com", "household_id": "h1"},
    {"id": "5", "type": "expense", "amount": 15, "date": "2026-09-15", "category": "Subscriptions", "note": "Netflix", "author_email": "ali@x.com", "household_id": "h1"},
    {"id": "6", "type": "income", "amount": 5200, "date": "2026-09-01", "category": "Salary", "note": "", "author_email": "ali@x.com", "household_id": "h1"},
    {"id": "7", "type": "expense", "amount": 220, "date": "2026-09-08", "category": "Groceries", "note": "", "author_email": "sara@x.com", "household_id": "h1"},
]


def test_spending_summary_totals():
    client = FakeClient(SAMPLE_ROWS)
    result = tools.spending_summary(client, "h1", "2026-08-01", "2026-08-31")
    assert result["income"] == 5000
    assert result["expense"] == 1715
    assert result["profit"] == 3285


def test_spending_by_category_sorted_desc():
    client = FakeClient(SAMPLE_ROWS)
    result = tools.spending_by_category(client, "h1", "2026-08-01", "2026-08-31", type="expense")
    cats = [c["category"] for c in result["by_category"]]
    assert cats[0] == "Rent & Housing"
    assert result["total"] == 1715


def test_compare_periods_percent_change():
    client = FakeClient(SAMPLE_ROWS)
    result = tools.compare_periods(
        client, "h1",
        period_a_start="2026-09-01", period_a_end="2026-09-30",
        period_b_start="2026-08-01", period_b_end="2026-08-31",
    )
    assert result["period_a"]["income"] == 5200
    assert result["period_b"]["income"] == 5000
    assert result["income_delta"]["change"] == 200


def test_detect_recurring_charges_flags_repeated_subscription():
    client = FakeClient(SAMPLE_ROWS)
    result = tools.detect_recurring_charges(client, "h1", as_of_date="2026-09-30")
    matches = [c for c in result["candidates"] if c["category"] == "Subscriptions"]
    assert len(matches) == 1
    assert matches[0]["months_seen"] == ["2026-08", "2026-09"]


def test_get_transactions_filters_by_category():
    client = FakeClient(SAMPLE_ROWS)
    result = tools.get_transactions(client, "h1", "2026-08-01", "2026-09-30", category="Groceries")
    assert result["count"] == 2
    assert all(t["category"] == "Groceries" for t in result["transactions"])


# ---------------------------------------------------------------------------
# Debts, recurring rules, profit goal
# ---------------------------------------------------------------------------

DEBT_ROWS = [
    {"id": "d1", "household_id": "h1", "name": "Chase Prime", "debt_type": "credit_card", "original_balance": 5000,
     "current_balance": 2500, "interest_rate": 24.99, "minimum_payment": 150, "created_at": "2026-01-01"},
    {"id": "d2", "household_id": "h1", "name": "Toyota auto loan", "debt_type": "loan", "original_balance": 23000,
     "current_balance": 16800, "interest_rate": 5.9, "minimum_payment": 420, "created_at": "2026-01-02"},
    {"id": "d3", "household_id": "h1", "name": "Best Buy card", "debt_type": "credit_card", "original_balance": 1200,
     "current_balance": 900, "interest_rate": None, "minimum_payment": 35, "created_at": "2026-01-03"},
    # another household's debt: must never show up
    {"id": "dx", "household_id": "h2", "name": "Not ours", "debt_type": "loan", "original_balance": 9,
     "current_balance": 9, "interest_rate": 1, "minimum_payment": 1, "created_at": "2026-01-04"},
]


def debt_client():
    return FakeClient(SAMPLE_ROWS, tables={"debts": DEBT_ROWS})


def test_get_debts_rows_progress_and_totals():
    result = tools.get_debts(debt_client(), "h1")
    assert result["count"] == 3
    chase = result["debts"][0]
    assert chase == {
        "name": "Chase Prime", "type": "Credit card", "original_balance": 5000.0, "current_balance": 2500.0,
        "interest_rate": 24.99, "minimum_payment": 150.0, "paid_off": 2500.0, "percent_paid_off": 50, "is_paid_off": False,
    }
    assert result["debts"][2]["interest_rate"] is None
    # Totals from the sums (the Debts page's journey): 29,200 started, 20,200 now -> 9,000 = 30.82% -> 30.8
    assert result["totals"] == {"original_balance": 29200.0, "current_balance": 20200.0, "paid_off": 9000.0, "percent_paid_off": 30.8}


def test_get_debts_percentages_round_down_like_the_app():
    rows = [{"id": "d", "household_id": "h1", "name": "Card", "debt_type": "credit_card", "original_balance": 10000,
             "current_balance": 5004, "interest_rate": None, "minimum_payment": None, "created_at": "x"}]
    result = tools.get_debts(FakeClient([], tables={"debts": rows}), "h1")
    assert result["debts"][0]["percent_paid_off"] == 49  # 49.96% never shows as 50
    assert result["totals"]["percent_paid_off"] == 49.9
    assert result["debts"][0]["minimum_payment"] is None


def test_debt_payoff_projection_matches_the_debts_page():
    # Chase Prime as shown on the Debts page on 2026-09-26: "paid off around February 2028
    # (17 months)" and "About $52.06 of each payment goes to interest".
    result = tools.debt_payoff_projection(None, "h1", current_balance=2500, minimum_payment=150,
                                          interest_rate=24.99, as_of_date="2026-09-26")
    assert result["status"] == "paying_down"
    assert result["rough_estimate"]["months"] == 17
    assert result["rough_estimate"]["payoff_month"] == "2028-02"
    assert result["rough_estimate"]["payoff_month_label"] == "February 2028"
    assert result["monthly_interest_now"] == 52.06
    assert result["minimum_covers_interest"] is True
    with_interest = result["with_interest"]
    assert with_interest["pays_off"] is True
    assert with_interest["months"] > 17  # interest makes it take longer than the rough estimate
    assert with_interest["total_interest"] > 0
    assert with_interest["total_paid"] == round(2500 + with_interest["total_interest"], 2)


def test_debt_payoff_projection_interest_arithmetic():
    # 200 at 12% APR (1%/month), paying 101: month 1 interest 2.00 -> 101.00 left; month 2
    # interest 1.01 -> 1.01 left; month 3 interest 0.0101 -> paid. Total interest 3.0201.
    result = tools.debt_payoff_projection(None, "h1", current_balance=200, minimum_payment=101,
                                          interest_rate=12, as_of_date="2026-01-15")
    assert result["with_interest"]["months"] == 3
    assert result["with_interest"]["total_interest"] == 3.02
    assert result["with_interest"]["payoff_month"] == "2026-04"
    assert result["rough_estimate"]["months"] == 2  # ceil(200 / 101)


def test_debt_payoff_projection_flags_minimum_below_interest():
    result = tools.debt_payoff_projection(None, "h1", current_balance=10000, minimum_payment=100,
                                          interest_rate=24, as_of_date="2026-09-26")
    assert result["monthly_interest_now"] == 200.0
    assert result["minimum_covers_interest"] is False
    assert result["with_interest"]["pays_off"] is False


def test_debt_payoff_projection_edge_cases():
    assert tools.debt_payoff_projection(None, "h1", current_balance=0, minimum_payment=50)["status"] == "paid_off"
    assert tools.debt_payoff_projection(None, "h1", current_balance=900)["status"] == "no_minimum_payment"
    no_rate = tools.debt_payoff_projection(None, "h1", current_balance=900, minimum_payment=35, as_of_date="2026-09-26")
    assert no_rate["rough_estimate"]["months"] == 26  # ceil(900 / 35)
    assert no_rate["with_interest"] is None


def test_debt_payoff_comparison_side_by_side():
    result = tools.debt_payoff_comparison(debt_client(), "h1", "chase prime", "Toyota", as_of_date="2026-09-26")
    names = [d["name"] for d in result["debts"]]
    assert names == ["Chase Prime", "Toyota auto loan"]  # case-insensitive and partial names resolve
    assert result["debts"][0]["projection"]["rough_estimate"]["months"] == 17
    assert result["debts"][1]["projection"]["rough_estimate"]["months"] == 40  # ceil(16800 / 420)
    assert result["facts"]["higher_interest_rate"] == "Chase Prime"
    assert result["facts"]["smaller_balance"] == "Chase Prime"
    assert result["facts"]["larger_projected_interest_cost"] == "Toyota auto loan"


def test_debt_payoff_comparison_unknown_name_lists_real_debts():
    try:
        tools.debt_payoff_comparison(debt_client(), "h1", "Chase Prime", "Amex")
    except ValueError as exc:
        assert "Amex" in str(exc) and "Toyota auto loan" in str(exc) and "Not ours" not in str(exc)
    else:
        raise AssertionError("expected a ValueError for an unknown debt")


RULE_ROWS = [
    {"id": "r1", "household_id": "h1", "type": "expense", "amount": 2150, "category": "Rent / Mortgage", "note": "Rent", "day_of_month": 1, "active": True},
    {"id": "r2", "household_id": "h1", "type": "income", "amount": 4200, "category": "Salary", "note": "", "day_of_month": 28, "active": True},
    {"id": "r3", "household_id": "h1", "type": "expense", "amount": 40, "category": "Fitness", "note": "Gym", "day_of_month": 5, "active": False},
    {"id": "r4", "household_id": "h2", "type": "expense", "amount": 9, "category": "Other", "note": "Not ours", "day_of_month": 2, "active": True},
]


def test_get_recurring_rules_active_only_with_next_occurrence():
    result = tools.get_recurring_rules(FakeClient([], tables={"recurring_rules": RULE_ROWS}), "h1", as_of_date="2026-09-26")
    assert result["count"] == 2  # the paused Gym rule and the other household's rule are excluded
    rent, salary = result["rules"]
    assert rent == {"name": "Rent", "category": "Rent / Mortgage", "type": "expense", "amount": 2150.0,
                    "day_of_month": 1, "next_occurrence": "2026-10-01"}  # the 1st has passed -> next month
    assert salary["name"] == "Salary"  # no note: the app shows the category
    assert salary["next_occurrence"] == "2026-09-28"  # still to come this month


def test_get_recurring_rules_next_occurrence_rolls_over_the_year():
    result = tools.get_recurring_rules(FakeClient([], tables={"recurring_rules": RULE_ROWS}), "h1", as_of_date="2026-12-15")
    assert result["rules"][0]["next_occurrence"] == "2027-01-01"


def goal_rows():
    # July: +1000, August: +3000 -> earlier-month average 2000. September so far: 5200 - 700 = +4500.
    return [
        {"id": "a", "household_id": "h1", "type": "income", "amount": 3000, "date": "2026-07-01"},
        {"id": "b", "household_id": "h1", "type": "expense", "amount": 2000, "date": "2026-07-20"},
        {"id": "c", "household_id": "h1", "type": "income", "amount": 5000, "date": "2026-08-01"},
        {"id": "d", "household_id": "h1", "type": "expense", "amount": 2000, "date": "2026-08-15"},
        {"id": "e", "household_id": "h1", "type": "income", "amount": 5200, "date": "2026-09-01"},
        {"id": "f", "household_id": "h1", "type": "expense", "amount": 700, "date": "2026-09-10"},
    ]


def test_profit_goal_status_uses_the_average_of_earlier_months():
    client = FakeClient(goal_rows(), tables={"households": [{"id": "h1", "profit_goal_override": None}]})
    result = tools.profit_goal_status(client, "h1", as_of_date="2026-09-26")
    assert result["period"] == "2026-09"
    assert result["profit"] == 4500.0
    assert result["goal"] == 2000.0 and result["goal_source"] == "average of earlier periods"
    assert result["earlier_periods_averaged"] == 2
    assert result["percent_of_goal"] == 225  # what the ring's label shows
    assert result["ring_fill_percent"] == 100  # the ring itself stops at full


def test_profit_goal_status_custom_goal_wins():
    client = FakeClient(goal_rows(), tables={"households": [{"id": "h1", "profit_goal_override": 6000}]})
    result = tools.profit_goal_status(client, "h1", as_of_date="2026-09-26")
    assert result["goal"] == 6000.0 and result["goal_source"] == "custom"
    assert result["percent_of_goal"] == 75
    annual = tools.profit_goal_status(client, "h1", period="annual", as_of_date="2026-09-26")
    assert annual["goal"] == 72000.0  # annual view uses 12x the monthly goal


def test_profit_goal_status_defaults_when_there_is_no_history_or_a_loss():
    rows = [{"id": "x", "household_id": "h1", "type": "expense", "amount": 500, "date": "2026-08-02"},
            {"id": "y", "household_id": "h1", "type": "income", "amount": 1000, "date": "2026-09-02"}]
    client = FakeClient(rows, tables={"households": [{"id": "h1"}]})  # column missing = migration not run
    result = tools.profit_goal_status(client, "h1", as_of_date="2026-09-26")
    assert result["goal"] == 3000.0 and result["goal_source"] == "default"  # August averaged a loss
    assert result["goal_display"] == 3000
    assert result["percent_of_goal"] == 33


def test_profit_goal_percent_rounds_like_javascript():
    # 625 / 5000 = 12.5% -> JavaScript's Math.round gives 13 (Python's round() would give 12)
    rows = [{"id": "z", "household_id": "h1", "type": "income", "amount": 625, "date": "2026-09-02"}]
    client = FakeClient(rows, tables={"households": [{"id": "h1", "profit_goal_override": 5000}]})
    assert tools.profit_goal_status(client, "h1", as_of_date="2026-09-26")["percent_of_goal"] == 13


def test_every_tool_schema_has_an_implementation():
    assert {s["name"] for s in tools.TOOL_SCHEMAS} == set(tools.TOOL_IMPLEMENTATIONS)


def test_system_prompt_has_todays_date_and_debt_tone_rules():
    from datetime import date
    from app import agent
    prompt = agent.build_system_prompt(date(2026, 9, 29))
    assert "2026-09-29" in prompt
    assert "Lead with progress made" in prompt
    assert 'Never state a bare "you owe $X"' in prompt
