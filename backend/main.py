import os
from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional
import httpx

from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from tribe_scorer import score_content

# ---------------------------------------------------------------------------
# Sentry initialization (optional — silently skipped if SENTRY_DSN is unset)
# ---------------------------------------------------------------------------
_SENTRY_DSN = os.environ.get("SENTRY_DSN")
if _SENTRY_DSN:
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration

        sentry_sdk.init(
            dsn=_SENTRY_DSN,
            integrations=[FastApiIntegration()],
            traces_sample_rate=0.0,
            send_default_pii=False,
        )
    except Exception:  # pragma: no cover - never let telemetry break the app
        pass


# ---------------------------------------------------------------------------
# Rate limiter — per-IP, in-memory (works on a single Vercel worker instance)
# ---------------------------------------------------------------------------
def _client_ip(request: Request) -> str:
    """Resolve the real client IP, honoring Vercel's proxy header."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        # X-Forwarded-For may be a comma-separated list — first entry is the client
        return forwarded.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


limiter = Limiter(key_func=_client_ip, default_limits=[])

app = FastAPI(title="Virality Score API")
app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)


@app.exception_handler(RateLimitExceeded)
async def _rate_limit_handler(request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "Rate limit exceeded. Try again later."},
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

MAX_BYTES = 100 * 1024 * 1024  # 100 MB


class ScoreUrlRequest(BaseModel):
    url: str = Field(..., min_length=1)
    type: str = Field("ad")
    platform: str = Field("tiktok")


@app.get("/api/health")
def health():
    return {"status": "ok"}


VALID_PLATFORMS = ("tiktok", "reels", "shorts", "linkedin")


@app.post("/api/score")
@limiter.limit("10/hour")
async def score(
    request: Request,
    file: UploadFile = File(...),
    type: str = Form("ad"),
    audio: Optional[UploadFile] = File(None),
    platform: str = Form("tiktok"),
):
    if type not in ("ad", "video"):
        raise HTTPException(400, "type must be 'ad' or 'video'")
    if platform not in VALID_PLATFORMS:
        platform = "tiktok"

    contents = await file.read()
    if len(contents) > MAX_BYTES:
        raise HTTPException(413, "File too large (max 100 MB)")

    audio_bytes: Optional[bytes] = None
    if audio is not None:
        audio_bytes = await audio.read()
        if len(audio_bytes) > MAX_BYTES:
            audio_bytes = None  # too large — skip audio, still score visually

    try:
        return score_content(
            contents,
            file.content_type,
            type,
            audio_bytes=audio_bytes,
            platform=platform,
        )
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(500, f"Scoring failed: {exc}") from exc


@app.post("/api/score-url")
@limiter.limit("10/hour")
async def score_url(request: Request, payload: ScoreUrlRequest):
    if payload.type not in ("ad", "video"):
        raise HTTPException(400, "type must be 'ad' or 'video'")
    platform = payload.platform if payload.platform in VALID_PLATFORMS else "tiktok"

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
            resp = await client.get(payload.url)
            resp.raise_for_status()
            contents = resp.content
            content_type = resp.headers.get("content-type", "").split(";")[0].strip() or None
    except httpx.HTTPError as exc:
        raise HTTPException(400, f"Could not fetch URL: {exc}") from exc

    if len(contents) > MAX_BYTES:
        raise HTTPException(413, "Remote content too large (max 100 MB)")
    if not contents:
        raise HTTPException(400, "Remote URL returned empty body")

    try:
        return score_content(contents, content_type, payload.type, platform=platform)
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(500, f"Scoring failed: {exc}") from exc
