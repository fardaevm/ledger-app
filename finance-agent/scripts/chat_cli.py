"""
Minimal REPL for exercising the agent without wiring up any frontend.

Usage:
    python scripts/chat_cli.py

You'll need a Supabase access token for a real signed-in user — easiest
way to get one during dev: sign into the ledger-app in your browser, open
devtools, and run this in the console:

    JSON.parse(localStorage.getItem(
      Object.keys(localStorage).find(k => k.includes('auth-token'))
    )).access_token

Paste the result when prompted.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dotenv import load_dotenv  # noqa: E402

load_dotenv()

from app import agent  # noqa: E402
from app.supabase_client import client_for_user, get_household_id  # noqa: E402


def main() -> None:
    token = input("Supabase access token: ").strip()
    client = client_for_user(token)
    household_id = get_household_id(client)
    if household_id is None:
        print("No household found for this token — join or create one in the app first.")
        return

    print(f"Connected. household_id={household_id}")
    print("Type a question, or 'quit' to exit.\n")

    history: list[dict] = []
    while True:
        message = input("you> ").strip()
        if message.lower() in ("quit", "exit"):
            break

        result = agent.run_agent(client, household_id, history, message)

        for call in result.tool_calls:
            print(f"  [tool] {call.name}({call.input}) -> {call.output}")
        print(f"assistant> {result.reply}\n")

        history.append({"role": "user", "content": message})
        history.append({"role": "assistant", "content": result.reply})


if __name__ == "__main__":
    main()
