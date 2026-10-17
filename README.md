# LiveKit Voice Agent Demo

Talk to an AI voice agent from your browser.

```
Browser (livekit-client) ──token──► FastAPI (backend/server.py)
        │  WebRTC audio
        ▼
LiveKit server (local) ◄── Python agent (backend/agent.py)
                            Deepgram STT → Gemini or OpenAI LLM → Cartesia TTS
                            + local Silero VAD, turn detector, tools
```

Every browser connection gets its own room, and LiveKit dispatches a separate agent job to it.

## Prerequisites

- macOS with Homebrew, Python 3.11+, and [uv](https://docs.astral.sh/uv/)
- `brew install livekit livekit-cli` (LiveKit server + `lk` CLI)
- API keys: [Deepgram](https://console.deepgram.com), [Google AI Studio](https://aistudio.google.com/apikey), [Cartesia](https://play.cartesia.ai)

## Setup

```bash
cd backend
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.txt
cp .env.example .env   # then fill in DEEPGRAM_API_KEY, CARTESIA_API_KEY and the LLM key
```

The LLM is chosen with `LLM_PROVIDER` in `.env`: `gemini` (default, needs `GOOGLE_API_KEY`)
or `openai` (needs `OPENAI_API_KEY`). There is no automatic failover between them.

`.env` is read once at startup, so restart `lk agent dev` and uvicorn after editing it.

## Run (three terminals)

```bash
# 1. LiveKit server
livekit-server --dev

# 2. Agent worker (hot reload on file changes)
cd backend && source .venv/bin/activate
lk agent dev --dev --deployment production agent.py

# 3. Token server + frontend
cd backend && .venv/bin/uvicorn server:app --port 8080
```

Open http://localhost:8080, click **Connect**, allow the microphone, and start talking.

`--deployment production` is needed with a local server: by default `lk agent dev` registers
under a random deployment ID, and the local server does not dispatch jobs to it.

## Try saying

- "What time is it?" (calls `get_current_time`)
- "Roll a 20-sided die." (calls `roll_dice`)
- Interrupt the agent while it is talking: it stops and listens.

## Files

| File | Purpose |
|---|---|
| `backend/agent.py` | Agent instructions, tools, and the voice pipeline |
| `backend/server.py` | `POST /api/token` (new room + token per user) and serves `frontend/` |
| `frontend/app.js` | Connects to the room, plays agent audio, shows transcripts and agent state |
