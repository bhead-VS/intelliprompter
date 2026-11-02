"""Intelliprompter server.

Serves the cockpit UI and keeps API keys server-side:
  * POST /api/stt-token  -> short-lived OpenAI Realtime transcription token for the browser
  * POST /api/check      -> asks TypeSafe Jev which topics the speaker has covered
"""

import asyncio
import os
import re
import secrets
from pathlib import Path
from typing import List, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

load_dotenv()

TYPESAFE_API_KEY = os.getenv("TYPESAFE_API_KEY", "")
TYPESAFE_BASE_URL = os.getenv("TYPESAFE_BASE_URL", "https://api.typesafe.ai").rstrip("/")
JEV_MODEL = os.getenv("JEV_MODEL", "jev-latest")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
STT_MODEL = os.getenv("STT_MODEL", "gpt-4o-mini-transcribe")
STT_LANGUAGE = os.getenv("STT_LANGUAGE", "en")
# Optional shared passcode so only teammates can burn the corp keys.
ACCESS_CODE = os.getenv("ACCESS_CODE", "")
# Fake Jev with word overlap so the UI can be exercised without a key.
MOCK_JEV = os.getenv("MOCK_JEV", "0") == "1"

# Jev questions per request. Kept small so a long topic list is split into parallel calls.
QUESTIONS_PER_CALL = 10

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="Intelliprompter")
http = httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0))


def require_access(code: Optional[str]) -> None:
    if ACCESS_CODE and not (code and secrets.compare_digest(code, ACCESS_CODE)):
        raise HTTPException(status_code=401, detail="Wrong or missing access code")


class Topic(BaseModel):
    id: str
    text: str = Field(..., max_length=500)
    detail: Optional[str] = Field(None, max_length=1000)


class CheckRequest(BaseModel):
    transcript: str = Field(..., max_length=20000)
    topics: List[Topic] = Field(..., max_length=100)


def build_question(topic: Topic) -> dict:
    subject = topic.text if not topic.detail else f"{topic.text} ({topic.detail})"
    return {
        "type": "noul",
        "instructions": f"Is the speaker talking about, or have they covered, this topic: {subject}?",
        "criteria": {
            "true": "The speaker discusses this idea, even paraphrased, ad-libbed or using different words.",
            "false": "The idea is not discussed, or it is only named as something that will come up later.",
        },
    }


def mock_jev(transcript: str, topics: List[Topic]) -> dict:
    words = set(re.findall(r"[a-z]{4,}", transcript.lower()))
    answers = {}
    for t in topics:
        keys = set(re.findall(r"[a-z]{4,}", f"{t.text} {t.detail or ''}".lower()))
        answers[t.id] = {"type": "noul", "noul": len(keys & words) / len(keys) if keys else 0.0}
    return {"model": "mock", "answers": answers, "usage": {"input_tokens": 0}}


async def ask_jev(transcript: str, topics: List[Topic]) -> dict:
    if MOCK_JEV:
        return mock_jev(transcript, topics)
    body = {
        "model": JEV_MODEL,
        "state": transcript,
        "questions": {t.id: build_question(t) for t in topics},
    }
    resp = await http.post(
        f"{TYPESAFE_BASE_URL}/v1/systemone",
        json=body,
        headers={"Authorization": f"Bearer {TYPESAFE_API_KEY}"},
    )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"TypeSafe returned {resp.status_code}: {resp.text[:300]}")
    return resp.json()


@app.get("/api/config")
async def config():
    return {
        "accessCodeRequired": bool(ACCESS_CODE),
        "jevConfigured": bool(TYPESAFE_API_KEY) or MOCK_JEV,
        "openaiConfigured": bool(OPENAI_API_KEY),
        "sttModel": STT_MODEL,
    }


@app.post("/api/check")
async def check(req: CheckRequest, x_access_code: Optional[str] = Header(None)):
    require_access(x_access_code)
    if not TYPESAFE_API_KEY and not MOCK_JEV:
        raise HTTPException(status_code=503, detail="TYPESAFE_API_KEY is not set on the server")
    if not req.topics or not req.transcript.strip():
        return {"scores": {}, "model": JEV_MODEL, "inputTokens": 0}

    chunks = [req.topics[i:i + QUESTIONS_PER_CALL] for i in range(0, len(req.topics), QUESTIONS_PER_CALL)]
    results = await asyncio.gather(*(ask_jev(req.transcript, c) for c in chunks))

    scores, tokens, model = {}, 0, JEV_MODEL
    for r in results:
        model = r.get("model", model)
        tokens += r.get("usage", {}).get("input_tokens", 0)
        for name, answer in r.get("answers", {}).items():
            scores[name] = answer.get("noul", 0.0)
    return {"scores": scores, "model": model, "inputTokens": tokens}


@app.post("/api/stt-token")
async def stt_token(x_access_code: Optional[str] = Header(None)):
    require_access(x_access_code)
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not set on the server")
    headers = {"Authorization": f"Bearer {OPENAI_API_KEY}"}

    # GA Realtime API: mint a client secret for a transcription-only session.
    ga_body = {
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": 24000},
                    "transcription": {"model": STT_MODEL, "language": STT_LANGUAGE},
                    "turn_detection": {"type": "server_vad", "silence_duration_ms": 400},
                    "noise_reduction": {"type": "near_field"},
                }
            },
        }
    }
    resp = await http.post("https://api.openai.com/v1/realtime/client_secrets", json=ga_body, headers=headers)
    if resp.status_code == 200:
        data = resp.json()
        return {"token": data["value"], "expiresAt": data.get("expires_at"), "api": "ga"}

    # Fallback: older beta transcription_sessions endpoint.
    beta_body = {
        "input_audio_format": "pcm16",
        "input_audio_transcription": {"model": STT_MODEL, "language": STT_LANGUAGE},
        "turn_detection": {"type": "server_vad", "silence_duration_ms": 400},
        "input_audio_noise_reduction": {"type": "near_field"},
    }
    beta = await http.post(
        "https://api.openai.com/v1/realtime/transcription_sessions",
        json=beta_body,
        headers={**headers, "OpenAI-Beta": "realtime=v1"},
    )
    if beta.status_code == 200:
        data = beta.json()["client_secret"]
        return {"token": data["value"], "expiresAt": data.get("expires_at"), "api": "beta"}

    raise HTTPException(status_code=502, detail=f"OpenAI token error {resp.status_code}: {resp.text[:300]}")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
