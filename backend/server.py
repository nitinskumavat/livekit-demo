import os
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from livekit import api

load_dotenv()

# Read at startup so a missing value stops the server instead of failing every request.
LIVEKIT_URL = os.environ.get("LIVEKIT_URL")
if not LIVEKIT_URL:
    raise RuntimeError("LIVEKIT_URL is not set in .env")

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app = FastAPI()


@app.post("/api/token")
def create_token() -> dict[str, str]:
    # One room per user: every connect gets a fresh room, and LiveKit
    # dispatches a new agent job to it automatically.
    room_name = f"demo-{uuid.uuid4().hex[:8]}"
    identity = f"user-{uuid.uuid4().hex[:8]}"

    token = (
        api.AccessToken()  # reads LIVEKIT_API_KEY / LIVEKIT_API_SECRET
        .with_identity(identity)
        .with_name("Guest")
        .with_grants(api.VideoGrants(room_join=True, room=room_name))
        .to_jwt()
    )
    return {"server_url": LIVEKIT_URL, "token": token, "room": room_name}


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
