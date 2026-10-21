"""Behaviour tests for the Assistant, driven by text through the real LLM.

These skip STT, TTS and turn detection: they check what the agent decides and
says, not how fast. Timing is what the Voice Lab panel is for.
"""

import re
from collections.abc import AsyncIterator

import pytest
from livekit.agents import AgentSession

from agent import Assistant, build_llm

pytestmark = pytest.mark.llm

# Markdown or emoji would be read out literally by the TTS.
UNSPEAKABLE = re.compile(
    r"[*#`_]|^\s*[-•]\s"  # markdown: emphasis, headings, code, bullets
    r"|[☀-➿⬀-⯿\U0001F300-\U0001FAFF]",  # emoji and pictographs, e.g. ☀ ✅ ⭐ 😀
    re.MULTILINE,
)


@pytest.fixture
async def session() -> AsyncIterator[AgentSession]:
    async with build_llm() as llm, AgentSession(llm=llm) as session:
        await session.start(Assistant())
        yield session


async def test_rolls_requested_die(session: AgentSession) -> None:
    result = await session.run(user_input="Roll a 20-sided die.")

    result.expect.contains_function_call(name="roll_dice", arguments={"sides": 20})


async def test_explains_out_of_range_die(session: AgentSession) -> None:
    result = await session.run(user_input="Roll a 500-sided die.")

    async with build_llm() as judge_llm:
        await (
            result.expect[-1]
            .is_message(role="assistant")
            .judge(judge_llm, intent="Says it cannot roll a 500-sided die, or that dice go up to 100 sides.")
        )


async def test_uses_clock_tool_for_time(session: AgentSession) -> None:
    result = await session.run(user_input="What time is it right now?")

    result.expect.contains_function_call(name="get_current_time")


async def test_replies_are_speakable(session: AgentSession) -> None:
    result = await session.run(user_input="Give me three quick tips for staying focused.")

    reply = result.expect[-1].is_message(role="assistant").event().item.text_content or ""
    assert not UNSPEAKABLE.search(reply), f"reply contains markdown or emoji: {reply!r}"


async def test_answers_hello_briefly_and_friendly(session: AgentSession) -> None:
    result = await session.run(user_input="Hello!")

    async with build_llm() as judge_llm:
        await (
            result.expect.next_event()
            .is_message(role="assistant")
            .judge(judge_llm, intent="A short, friendly greeting that offers help.")
        )
