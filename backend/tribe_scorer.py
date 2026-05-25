"""
TRIBE-inspired multimodal scoring.

Pipeline:
  1. Visual  — 6-frame storyboard JPEG → Groq vision LLM
  2. Audio   — 16 kHz mono WAV (first 60 s) → Groq Whisper transcription
              → pacing analysis (WPM, hook timing)
  3. Scoring — storyboard + transcript + pacing → LLM returns JSON scores

Falls back to a random mock if the API call fails.
"""
from __future__ import annotations

import base64
import io
import json
import os
import random
from typing import Optional

SYSTEM_PROMPT = """You are a viral content analyst trained on millions of high-performing social videos.

You will receive:
1. A STORYBOARD image — a 3x2 grid of 6 frames sampled evenly across the full video (timestamps shown in each frame corner). Use this to judge visual pacing, arc, hook strength, and retention.
2. (When available) The full VIDEO TRANSCRIPT and audio pacing data — use this to assess the verbal hook, speech clarity, emotional language, and CTA strength.

Analyze BOTH visual and audio signals together.

Return ONLY valid JSON with this exact structure:
{
  "overall": <0-100>,
  "emotion": <0-100>,
  "hook": <0-100>,
  "retention": <0-100>,
  "shareability": <0-100>,
  "trend": <0-100>,
  "feedback": {
    "summary": "<2 sentence assessment covering visuals AND speech/audio>",
    "strengths": ["<strength 1>", "<strength 2>"],
    "improvements": ["<fix 1>", "<fix 2>", "<fix 3>"]
  }
}

Score rubric:
- overall: weighted average of all dimensions
- emotion: does the video trigger a strong emotional response (visually + verbally)?
- hook: do the first frames AND first words immediately grab attention?
- retention: does pacing keep viewers watching to the end?
- shareability: will people send this to friends or repost it?
- trend: does it align with current platform trends and formats?"""

GROK_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"
GROK_BASE_URL = "https://api.groq.com/openai/v1"
WHISPER_MODEL = "whisper-large-v3-turbo"

# Platform-specific scoring context injected at the start of the user message.
PLATFORM_CONTEXT = {
    "tiktok": (
        "Platform: TikTok. Prioritize: first 1-2 second hook, trending audio/sounds, "
        "fast cuts, relatable humor, duet/stitch potential. Audience: 16-30."
    ),
    "reels": (
        "Platform: Instagram Reels. Prioritize: aesthetic quality, text overlays, "
        "saves/shares over likes, aspirational content, smooth transitions. Audience: 18-35."
    ),
    "shorts": (
        "Platform: YouTube Shorts. Prioritize: curiosity gap in title/hook, watch-through "
        "rate, subscribe prompt, educational or entertaining value. Audience: 18-40."
    ),
    "linkedin": (
        "Platform: LinkedIn. Prioritize: professional insight, storytelling, thought "
        "leadership, comment-bait questions, industry relevance. Audience: 25-45 professionals."
    ),
}


def score_content(
    file_bytes: bytes,
    content_type: Optional[str],
    media_type: str,
    audio_bytes: Optional[bytes] = None,
    platform: str = "tiktok",
) -> dict:
    """
    Returns virality scores (0-100) + qualitative feedback.

    Args:
        file_bytes:   raw storyboard image bytes
        content_type: MIME type hint
        media_type:   "video" or "ad"
        audio_bytes:  optional 16 kHz mono WAV for transcription
        platform:     "tiktok" | "reels" | "shorts" | "linkedin"
    """
    try:
        image_bytes, image_mime = _prepare_image(file_bytes, content_type, media_type)

        transcript: Optional[str] = None
        pacing: Optional[dict] = None
        if audio_bytes:
            transcript, pacing = _transcribe_audio(audio_bytes)

        result = _call_grok(image_bytes, image_mime, transcript, pacing, platform)
        out = _validate_result(result)

        # Attach transcript so frontend can display it
        if transcript:
            out["transcript"] = transcript.strip()
        return out

    except Exception:
        return _mock_score()


# ─── image preparation ────────────────────────────────────────────────────────

def _prepare_image(
    file_bytes: bytes, content_type: Optional[str], media_type: str
) -> tuple[bytes, str]:
    is_video = media_type == "video" or (content_type or "").startswith("video/")
    if is_video:
        return _extract_first_frame(file_bytes), "image/png"
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
        return file_bytes, content_type or "image/jpeg"


def _extract_first_frame(video_bytes: bytes) -> bytes:
    from PIL import Image  # type: ignore
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
        raise RuntimeError(f"Could not extract frame: {exc}") from exc


# ─── audio transcription ──────────────────────────────────────────────────────

def _transcribe_audio(audio_bytes: bytes) -> tuple[Optional[str], Optional[dict]]:
    """
    Transcribe WAV bytes via Groq Whisper.
    Returns (transcript_text, pacing_dict) or (None, None) on failure.
    """
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        return None, None
    try:
        from openai import OpenAI  # type: ignore
        client = OpenAI(api_key=api_key, base_url=GROK_BASE_URL)

        response = client.audio.transcriptions.create(
            file=("audio.wav", io.BytesIO(audio_bytes), "audio/wav"),
            model=WHISPER_MODEL,
            response_format="verbose_json",
        )

        text: str = getattr(response, "text", "") or ""
        duration: float = float(getattr(response, "duration", None) or 1.0)
        segments = getattr(response, "segments", None) or []

        # Pacing analysis
        word_count = len(text.split())
        wpm = round(word_count / max(duration / 60, 0.01))

        # Hook: does speech start within first 3 seconds?
        first_start = float(segments[0].get("start", 999)) if segments else 999.0
        has_early_hook = first_start < 3.0
        hook_text = (segments[0].get("text", "").strip() if (segments and has_early_hook) else "")

        pacing = {
            "words_per_min": wpm,
            "has_early_hook": has_early_hook,
            "hook_text": hook_text[:80],
            "duration_analyzed": round(duration),
        }
        return text, pacing

    except Exception:
        return None, None


# ─── Groq vision + text call ──────────────────────────────────────────────────

def _call_grok(
    image_bytes: bytes,
    image_mime: str,
    transcript: Optional[str] = None,
    pacing: Optional[dict] = None,
    platform: str = "tiktok",
) -> dict:
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("GROQ_API_KEY not set")

    from openai import OpenAI  # type: ignore
    client = OpenAI(api_key=api_key, base_url=GROK_BASE_URL)

    b64 = base64.b64encode(image_bytes).decode("ascii")
    data_url = f"data:{image_mime};base64,{b64}"

    platform_line = PLATFORM_CONTEXT.get(platform, PLATFORM_CONTEXT["tiktok"])

    if transcript:
        pacing_line = ""
        if pacing:
            hook_note = (
                f'Opens with: "{pacing["hook_text"]}"' if pacing["has_early_hook"]
                else "No speech in first 3 seconds"
            )
            pacing_line = (
                f"\n\nAudio pacing: {pacing['words_per_min']} words/min "
                f"over {pacing['duration_analyzed']}s analyzed. {hook_note}."
            )
        user_text = (
            f"{platform_line}\n\n"
            f"VIDEO TRANSCRIPT:\n{transcript}{pacing_line}\n\n"
            "Score this creative using BOTH the visual storyboard AND the transcript. "
            "Return ONLY the JSON object."
        )
    else:
        user_text = (
            f"{platform_line}\n\n"
            "Score this creative now. Return ONLY the JSON object."
        )

    response = client.chat.completions.create(
        model=GROK_MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
                    {"type": "text", "text": user_text},
                ],
            },
        ],
        temperature=0.4,
    )

    raw = response.choices[0].message.content or ""
    return _parse_json(raw)


# ─── helpers ──────────────────────────────────────────────────────────────────

def _parse_json(raw: str) -> dict:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
        text = text.strip()
        if text.endswith("```"):
            text = text[:-3].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end > start:
            return json.loads(text[start:end + 1])
        raise


def _validate_result(data: dict) -> dict:
    required = ("overall", "emotion", "hook", "retention", "shareability", "trend")
    out: dict = {k: _clamp_int(data.get(k, 0)) for k in required}
    feedback = data.get("feedback") or {}
    if not isinstance(feedback, dict):
        feedback = {}
    out["feedback"] = {
        "summary": str(feedback.get("summary", "")),
        "strengths": [str(s) for s in (feedback.get("strengths") or []) if s],
        "improvements": [str(i) for i in (feedback.get("improvements") or []) if i],
    }
    return out


def _clamp_int(value) -> int:
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        n = 0
    return max(0, min(100, n))


def _mock_score() -> dict:
    base = random.randint(55, 90)
    return {
        "overall": base,
        "emotion": _jitter(base),
        "hook": _jitter(base),
        "retention": _jitter(base),
        "shareability": _jitter(base),
        "trend": _jitter(base),
        "feedback": {
            "summary": "Mock scoring — Groq API was unreachable. Set GROQ_API_KEY for real analysis.",
            "strengths": ["Solid baseline composition", "Recognizable subject matter"],
            "improvements": [
                "Set GROQ_API_KEY to enable real scoring",
                "Verify network access to api.groq.com",
                "Re-upload once the live model is wired up",
            ],
        },
    }


def _jitter(base: int, spread: int = 15) -> int:
    return max(0, min(100, base + random.randint(-spread, spread)))
