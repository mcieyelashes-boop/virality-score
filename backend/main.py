from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import httpx

from tribe_scorer import score_content

app = FastAPI(title="Virality Score API")

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


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/score")
async def score(
    file: UploadFile = File(...),
    type: str = Form("ad"),
):
    if type not in ("ad", "video"):
        raise HTTPException(400, "type must be 'ad' or 'video'")

    contents = await file.read()
    if len(contents) > MAX_BYTES:
        raise HTTPException(413, "File too large (max 100 MB)")

    try:
        return score_content(contents, file.content_type, type)
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(500, f"Scoring failed: {exc}") from exc


@app.post("/api/score-url")
async def score_url(payload: ScoreUrlRequest):
    if payload.type not in ("ad", "video"):
        raise HTTPException(400, "type must be 'ad' or 'video'")

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
        return score_content(contents, content_type, payload.type)
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(500, f"Scoring failed: {exc}") from exc
