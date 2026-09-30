"""
Vercel entry point for the finance assistant: a Python serverless function in the same
project as the ledger-app web app, so it's served on the same origin (/api/chat,
/api/health) and needs no CORS.

vercel.json rewrites every /api/* path here and bundles finance-agent/app with this file
(`includeFiles`). The FastAPI app sees the original path, which is why its routes live under
/api. All the actual code is in finance-agent/ (see its README).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "finance-agent"))

from app.main import app  # noqa: E402,F401 — Vercel serves this ASGI app
