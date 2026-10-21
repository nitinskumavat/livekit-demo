"""Voice Lab: per-turn latency reports for the browser.

LiveKit measures every stage itself and attaches the numbers to each ChatMessage
as `llm.MetricsReport`. The user's message carries the turn-detection and
transcription delays; the agent's reply carries LLM, TTS and end-to-end timings.
This module publishes one report per turn on the `voice-lab.turn` data topic,
built from the user's message and the first reply after it.

Why only the first reply: when the agent speaks before calling a tool ("Let me
check..."), LiveKit records two assistant messages for one turn, and only the
first carries the end-to-end latency (what the user actually waited).
"""

import asyncio
import json
import logging

from livekit import rtc
from livekit.agents import AgentSession, ConversationItemAddedEvent, llm

TOPIC = "voice-lab.turn"

logger = logging.getLogger("voice-lab")


def build_turn_report(
    user_msg: llm.ChatMessage | None, agent_msg: llm.ChatMessage
) -> dict[str, float | None]:
    """Combine one user turn and the agent's reply into a report, in seconds.

    A stage LiveKit didn't measure is None, never a guess. `user_msg` is None for
    replies with no user turn before them, such as the greeting.
    """
    user_metrics = user_msg.metrics if user_msg else {}
    agent_metrics = agent_msg.metrics
    return {
        "e2e": agent_metrics.get("e2e_latency"),
        "end_of_turn": user_metrics.get("end_of_turn_delay"),
        "transcription": user_metrics.get("transcription_delay"),
        "llm_ttft": agent_metrics.get("llm_node_ttft"),
        "tts_ttfb": agent_metrics.get("tts_node_ttfb"),
    }


class TurnTracker:
    """Turns the stream of conversation messages into one report per turn."""

    def __init__(self) -> None:
        self._last_user_msg: llm.ChatMessage | None = None
        self._awaiting_reply = True  # the greeting counts as a turn with no user message

    def on_message(self, msg: llm.ChatMessage) -> dict[str, float | None] | None:
        """Return a report for the first reply of a turn, otherwise None."""
        if msg.role == "user":
            self._last_user_msg = msg
            self._awaiting_reply = True
        elif msg.role == "assistant" and self._awaiting_reply:
            report = build_turn_report(self._last_user_msg, msg)
            self._last_user_msg = None
            self._awaiting_reply = False
            return report
        return None


def attach_voice_lab(session: AgentSession, room: rtc.Room) -> None:
    """Publish a report for each turn: the greeting, then each user turn."""
    tracker = TurnTracker()
    pending: set[asyncio.Task[None]] = set()  # keep tasks referenced until they finish

    async def publish(report: dict[str, float | None]) -> None:
        if not room.isconnected():  # the call ended as the reply finished
            return
        try:
            await room.local_participant.publish_data(
                json.dumps(report), reliable=True, topic=TOPIC
            )
        except Exception:
            logger.warning("failed to publish voice lab report", exc_info=True)

    def on_item_added(ev: ConversationItemAddedEvent) -> None:
        if not isinstance(ev.item, llm.ChatMessage):
            return
        report = tracker.on_message(ev.item)
        if report is None:
            return
        task = asyncio.create_task(publish(report))
        pending.add(task)
        task.add_done_callback(pending.discard)

    session.on("conversation_item_added", on_item_added)
