"""
TRIBE v2 scoring stub.
Replace the mock logic below with real model inference calls.
"""
import random


def score_content(file_bytes: bytes, content_type: str, media_type: str) -> dict:
    """
    Returns virality dimension scores (0-100).
    Swap out the random stubs for actual TRIBE v2 model calls.
    """
    # TODO: load TRIBE v2 model and run inference on file_bytes
    base = random.randint(55, 90)
    return {
        "overall": base,
        "emotion": _jitter(base),
        "hook": _jitter(base),
        "retention": _jitter(base),
        "shareability": _jitter(base),
        "trend": _jitter(base),
    }


def _jitter(base: int, spread: int = 15) -> int:
    return max(0, min(100, base + random.randint(-spread, spread)))
