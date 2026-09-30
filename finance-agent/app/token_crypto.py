"""
Encryption for stored Plaid access tokens.

A Plaid access_token is a live credential for someone's bank login, so it's encrypted
before it reaches the database and decrypted only in memory, right before a Plaid call.
Fernet (AES-128-CBC + HMAC-SHA256, from `cryptography`) also authenticates: a tampered or
wrongly keyed ciphertext fails to decrypt instead of producing garbage.

The key is PLAID_TOKEN_ENCRYPTION_KEY, a server-only environment variable (never VITE_,
never committed). Generate one with:
    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
Losing or changing it makes every stored token unreadable: those banks must be linked again.
"""

import os

from cryptography.fernet import Fernet, InvalidToken

KEY_ENV = "PLAID_TOKEN_ENCRYPTION_KEY"


class TokenCryptoError(RuntimeError):
    """The key is missing or malformed, or a stored token can't be decrypted with it. The
    message never contains the token."""


def _fernet() -> Fernet:
    key = os.environ.get(KEY_ENV)
    if not key:
        raise TokenCryptoError(f"{KEY_ENV} is not set")
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError):
        raise TokenCryptoError(f"{KEY_ENV} is not a valid Fernet key") from None


def key_configured() -> bool:
    try:
        _fernet()
    except TokenCryptoError:
        return False
    return True


def encrypt_token(token: str) -> str:
    return _fernet().encrypt(token.encode()).decode()


def decrypt_token(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        raise TokenCryptoError("a stored Plaid token couldn't be decrypted (was the key changed?)") from None
