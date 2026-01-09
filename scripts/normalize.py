import re
import unicodedata

# Catches emojis outside the BMP (kept as a fallback)
_EMOJI_RE = re.compile(r"[\U00010000-\U0010ffff]", flags=re.UNICODE)

def normalize_name(s: str) -> str:
    """Lowercase + trim + collapse whitespace."""
    return " ".join((s or "").strip().lower().split())

def normalize_category(s: str) -> str:
    """
    Lowercase + trim + collapse whitespace, and remove emoji/symbol-like chars.
    This handles cases like '☕ coffee' where the emoji isn't matched by _EMOJI_RE.
    """
    s = (s or "").strip()

    # Remove all unicode symbols (this includes many emojis like ☕)
    s = "".join(ch for ch in s if unicodedata.category(ch)[0] != "S")

    # Fallback: remove high-codepoint emojis too
    s = _EMOJI_RE.sub("", s)

    return " ".join(s.lower().split())
