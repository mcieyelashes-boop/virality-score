"""
TRIBE v2 scoring — Grok vision-backed implementation.

Calls xAI's Grok vision model to score a creative across multiple
virality dimensions and produce qualitative feedback. Falls back to
a random mock if the API call fails (e.g. missing API key).
"""
from __future__ import annotations

import base64
import io
import json
import os
import random
from typing import Optional

SYSTEM_PROMPT = """You are a viral content analyst trained on millions of high-performing ads and social videos.
Analyze the provided creative and return ONLY valid JSON with this exact structure:
{
  "overall": <0-100>,
  "emotion": <0-100>,
  "hook": <0-100>,
  "retention": <0-100>,
  "shareability": <0-100>,
  "trend": <0-100>,
  "feedback": {
    "summary": "<2 sentence overall assessment>",
    "strengths": ["<strength 1>", "<strength 2>"],
    "improvements": ["<specific fix 1>", "<specific fix 2>", "<specific fix 3>"]
  }
}
Score rubric:
- overall: weighted average of all dimensions
- emotion: does it trigger a strong emotional response?
- hook: does the first 3 seconds grab attention?
- retention: will people watch to the end or scroll past?
- shareability: will people send this to friends?
- trend: does it align with current platform trends?"""

GROK_MODEL = "grok-2-vision-latest"
GROK_BASE_URL = "https://api.x.ai/v1"


def score_content(file_bytes: bytes, content_type: Optional[str], media_type: str) -> dict:
    """
    Returns virality dimension scores (0-100) plus qualitative feedback.

    Args:
        file_bytes: raw image or video bytes
        content_type: MIME type (optional, used as a hint)
        media_type: "ad" or "video"
    """
    try:
        image_bytes, image_mime = _prepare_image(file_bytes, content_type, media_type)
        result = _call_grok(image_bytes, image_mime)
        return _validate_result(result)
    except Exception:
        # Fall back to mock scoring on any error (missing key, network, parse, etc.)
        return _mock_score()


def _prepare_image(file_bytes: bytes, content_type: Optional[str], media_type: str) -> tuple[bytes, str]:
    """Return (image_bytes, mime_type). For video, extracts the first frame."""
    is_video = media_type == "video" or (content_type or "").startswith("video/")

    if is_video:
        frame_bytes = _extract_first_frame(file_bytes)
        return frame_bytes, "image/png"

    # Treat as image — re-encode through PIL to normalize the format.
    try:
        from PIL import Image  # type: ignore

        img = Image.open(io.BytesIO(file_bytes))
        img.load()
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue(), "image/png"
    except Exception:
        # If PIL can't read it, pass through original bytes with best-guess mime.
        return file_bytes, content_type or "image/jpeg"


def _extract_first_frame(video_bytes: bytes) -> bytes:
    """
    Extract the first frame of a video as PNG bytes.

    Pillow can open animated GIF/WebP via Image.open. For real video
    formats (mp4/mov/webm) we attempt imageio if available; otherwise
    we raise so the caller can fall back.
    """
    from PIL import Image  # type: ignore

    # Try PIL first (works for GIF/animated WebP).
    try:
        img = Image.open(io.BytesIO(video_bytes))
        img.seek(0)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        pass

    # Try imageio for proper video containers.
    try:
        import imageio.v3 as iio  # type: ignore

        frame = iio.imread(io.BytesIO(video_bytes), index=0)
        img = Image.fromarray(frame)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as exc:
        raise RuntimeError(f"Could not extract first frame from video: {exc}") from exc


def _call_grok(image_bytes: bytes, image_mime: str) -> dict:
    """Send the image to Grok and parse the JSON response."""
    api_key = os.environ.get("XAI_API_KEY")
    if not api_key:
        raise RuntimeError("XAI_API_KEY not set")

    from openai import OpenAI  # type: ignore

    client = OpenAI(api_key=api_key, base_url=GROK_BASE_URL)

    b64 = base64.b64encode(image_bytes).decode("ascii")
    data_url = f"data:{image_mime};base64,{b64}"

    response = client.chat.completions.create(
        model=GROK_MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
                    {"type": "text", "text": "Score this creative now. Return ONLY the JSON object."},
                ],
            },
        ],
        temperature=0.4,
    )

    raw = response.choices[0].message.content or ""
    return _parse_json(raw)


def _parse_json(raw: str) -> dict:
    """Parse JSON, tolerating fenced code blocks or surrounding prose."""
    text = raw.strip()
    if text.startswith("```"):
        # Strip ```json ... ``` fences
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
        if text.endswith("```"):
            text = text[:-3].strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to locate the first {...} block.
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            return json.loads(text[start : end + 1])
        raise


def _validate_result(data: dict) -> dict:
    """Coerce/validate the Grok response into the expected shape."""
    required_scores = ("overall", "emotion", "hook", "retention", "shareability", "trend")
    out: dict = {}
    for key in required_scores:
        out[key] = _clamp_int(data.get(key, 0))

    feedback = data.get("feedback") or {}
    if not isinstance(feedback, dict):
        feedback = {}

    strengths = feedback.get("strengths") or []
    improvements = feedback.get("improvements") or []
    out["feedback"] = {
        "summary": str(feedback.get("summary", "")),
        "strengths": [str(s) for s in strengths if s],
        "improvements": [str(i) for i in improvements if i],
    }
    return out


def _clamp_int(value) -> int:
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        n = 0
    return max(0, min(100, n))


def _mock_score() -> dict:
    """Random fallback used when Grok is unavailable."""
    base = random.randint(55, 90)
    return {
        "overall": base,
        "emotion": _jitter(base),
        "hook": _jitter(base),
        "retention": _jitter(base),
        "shareability": _jitter(base),
        "trend": _jitter(base),
        "feedback": {
            "summary": "Mock scoring engaged — Grok vision API was not reachable, so these numbers are placeholders.",
            "strengths": [
                "Solid baseline composition",
                "Recognizable subject matter",
            ],
            "improvements": [
                "Configure XAI_API_KEY to enable real Grok scoring",
                "Verify network access to api.x.ai",
                "Re-run once the live model is wired up",
            ],
        },
    }


def _jitter(base: int, spread: int = 15) -> int:
    return max(0, min(100, base + random.randint(-spread, spread)))
