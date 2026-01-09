import re

_EMOJI_RE = re.compile(r"[\U00010000-\U0010ffff]", flags=re.UNICODE)

def normalize_name(s: str) -> str:
    return " ".join((s or "").strip().lower().split())

def normalize_category(s: str) -> str:
    s = (s or "").strip()
    s = _EMOJI_RE.sub("", s)
    return " ".join(s.lower().split())