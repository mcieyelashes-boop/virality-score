from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from tribe_scorer import score_content

app = FastAPI(title="Virality Score API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/score")
async def score(
    file: UploadFile = File(...),
    type: str = Form("ad"),
):
    if type not in ("ad", "video"):
        raise HTTPException(400, "type must be 'ad' or 'video'")

    contents = await file.read()
    if len(contents) > 100 * 1024 * 1024:
        raise HTTPException(413, "File too large (max 100 MB)")

    result = score_content(contents, file.content_type, type)
    return result
