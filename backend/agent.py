import logging
import os
import random
from datetime import datetime

from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    RunContext,
    cli,
    function_tool,
    inference,
    llm,
)
from livekit.plugins import cartesia, deepgram, google, openai

from voice_lab import attach_voice_lab

load_dotenv()

logger = logging.getLogger("demo-agent")


class Assistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are a friendly voice assistant in a LiveKit demo. "
                "The user talks to you through their microphone and hears your replies as speech. "
                "Keep answers short and conversational, one to three sentences. "
                "Do not use markdown, lists, emojis, or symbols that cannot be spoken. "
                "Use your tools when the user asks for the time or wants to roll dice. "
                "If you do not know something, say so instead of guessing."
            ),
        )

    @function_tool
    async def get_current_time(self, context: RunContext) -> str:
        """Get the current local date and time."""
        now = datetime.now().astimezone()
        logger.info("get_current_time called")
        return now.strftime("%A, %d %B %Y, %I:%M %p %Z")

    @function_tool
    async def roll_dice(self, context: RunContext, sides: int = 6) -> str:
        """Roll a single die and return the result.

        Args:
            sides: Number of sides on the die, between 2 and 100.
        """
        if not 2 <= sides <= 100:
            return "The die must have between 2 and 100 sides."
        result = random.randint(1, sides)
        logger.info("roll_dice called", extra={"sides": sides, "result": result})
        return f"Rolled a {sides}-sided die: {result}"


# Checked at import so a bad value stops the worker at startup instead of failing every call.
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "gemini")
if LLM_PROVIDER not in ("gemini", "openai"):
    raise ValueError(f"Unknown LLM_PROVIDER {LLM_PROVIDER!r} in .env; use 'gemini' or 'openai'")


def build_llm() -> llm.LLM:
    """Pick the LLM from LLM_PROVIDER in .env. There is no automatic failover."""
    if LLM_PROVIDER == "openai":
        return openai.LLM(model="gpt-4.1")
    return google.LLM(model="gemini-3.5-flash-lite")


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    session = AgentSession(
        stt=deepgram.STT(model="nova-3"),
        llm=build_llm(),
        tts=cartesia.TTS(model="sonic-3"),
        vad=inference.VAD(model="silero"),
        turn_handling={
            # Local models only: the cloud turn detector and adaptive interruption
            # need LiveKit Cloud credentials, which a local dev server doesn't have.
            "turn_detection": inference.TurnDetector(version="v1-mini"),
            "interruption": {"mode": "vad"},
        },
    )
    attach_voice_lab(session, ctx.room)

    await session.start(agent=Assistant(), room=ctx.room)
    await session.generate_reply(instructions="Greet the user briefly and offer your help.")


if __name__ == "__main__":
    cli.run_app(server)
