from livekit.agents import llm

from voice_lab import TurnTracker, build_turn_report


def make_message(role: str, metrics: dict) -> llm.ChatMessage:
    return llm.ChatMessage(role=role, content=["text"], metrics=metrics)


def test_full_turn_combines_user_and_agent_metrics() -> None:
    user = make_message("user", {"end_of_turn_delay": 0.52, "transcription_delay": 0.21})
    agent = make_message(
        "assistant", {"llm_node_ttft": 0.31, "tts_node_ttfb": 0.18, "e2e_latency": 1.01}
    )

    assert build_turn_report(user, agent) == {
        "e2e": 1.01,
        "end_of_turn": 0.52,
        "transcription": 0.21,
        "llm_ttft": 0.31,
        "tts_ttfb": 0.18,
    }


def test_reply_without_user_turn_has_no_user_stages() -> None:
    # e.g. the greeting: nothing the user said comes before it
    agent = make_message("assistant", {"llm_node_ttft": 0.4, "tts_node_ttfb": 0.2})

    report = build_turn_report(None, agent)

    assert report["end_of_turn"] is None
    assert report["transcription"] is None
    assert report["e2e"] is None
    assert report["llm_ttft"] == 0.4


def test_missing_metrics_are_none_not_zero() -> None:
    report = build_turn_report(make_message("user", {}), make_message("assistant", {}))

    assert report == {
        "e2e": None,
        "end_of_turn": None,
        "transcription": None,
        "llm_ttft": None,
        "tts_ttfb": None,
    }


def test_greeting_is_reported_without_user_stages() -> None:
    tracker = TurnTracker()

    report = tracker.on_message(make_message("assistant", {"llm_node_ttft": 0.4}))

    assert report is not None
    assert report["llm_ttft"] == 0.4
    assert report["end_of_turn"] is None


def test_one_report_per_turn_when_agent_speaks_before_a_tool() -> None:
    # "Let me check..." then the answer after the tool: LiveKit records two
    # assistant messages, and only the first carries the end-to-end latency.
    tracker = TurnTracker()
    tracker.on_message(make_message("assistant", {}))  # greeting
    tracker.on_message(make_message("user", {"end_of_turn_delay": 0.5}))

    first = tracker.on_message(make_message("assistant", {"e2e_latency": 1.2}))
    after_tool = tracker.on_message(make_message("assistant", {"llm_node_ttft": 0.3}))

    assert first is not None
    assert first["e2e"] == 1.2
    assert first["end_of_turn"] == 0.5
    assert after_tool is None


def test_next_user_turn_starts_a_new_report() -> None:
    tracker = TurnTracker()
    tracker.on_message(make_message("assistant", {}))  # greeting
    tracker.on_message(make_message("user", {"end_of_turn_delay": 0.5}))
    tracker.on_message(make_message("assistant", {"e2e_latency": 1.0}))

    tracker.on_message(make_message("user", {"end_of_turn_delay": 0.7}))
    report = tracker.on_message(make_message("assistant", {"e2e_latency": 0.9}))

    assert report is not None
    assert report["end_of_turn"] == 0.7
    assert report["e2e"] == 0.9
