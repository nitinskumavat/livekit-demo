const { Room, RoomEvent, Track, createAudioAnalyser } = LivekitClient;

// Names published by livekit-agents (see livekit/agents/types.py).
const TRANSCRIPTION_TOPIC = "lk.transcription";
const ATTR_SEGMENT_ID = "lk.segment_id";
const ATTR_AGENT_STATE = "lk.agent.state";

const AGENT_JOIN_TIMEOUT_MS = 20000;
const BAR_COUNT = 15;

// Headline and hint for each UI state. Page-only states: precall, connecting, waiting, ended.
// Agent states (lk.agent.state): initializing, idle, listening, thinking, speaking.
const STATE_COPY = {
  precall: ["Ready when you are", "Start a call and talk to the assistant out loud."],
  connecting: ["Connecting", "Setting up your private room."],
  waiting: ["Waiting for the assistant", "It usually joins within a few seconds."],
  initializing: ["Assistant joining", "Getting ready to talk."],
  idle: ["Assistant ready", "Start talking whenever you like."],
  listening: ["Listening", "Go ahead, speak naturally."],
  thinking: ["Thinking", "Working on a reply."],
  speaking: ["Speaking", "Start talking any time to interrupt."],
  ended: ["Call ended", "Start another call whenever you like."],
};

const appEl = document.getElementById("app");
const vizEl = document.getElementById("viz");
const stateLabelEl = document.getElementById("state-label");
const stateHintEl = document.getElementById("state-hint");
const timerEl = document.getElementById("timer");
const transcriptEl = document.getElementById("transcript");
const micBtn = document.getElementById("mic-btn");
const micLabelEl = document.getElementById("mic-label");
const callBtn = document.getElementById("call-btn");
const audioContainer = document.getElementById("audio-container");
const transcriptPlaceholder = transcriptEl.querySelector(".transcript-empty").cloneNode(true);

const bars = Array.from({ length: BAR_COUNT }, () => {
  const bar = document.createElement("span");
  bar.className = "bar";
  vizEl.appendChild(bar);
  return bar;
});

let room = null;
let agentParticipant = null;
let agentAnalyser = null;
let micAnalyser = null;
let userEnded = false;
let joinTimer = null;
let clockTimer = null;
let frame = null;
let currentState = "precall";
const segments = new Map(); // segment id -> message text element
const userSegmentTimes = new Map(); // segment id -> timestamp of the newest user update shown

// ---------- UI state ----------

function setState(state, copy = STATE_COPY[state]) {
  currentState = state;
  appEl.dataset.state = state;
  stateLabelEl.textContent = copy[0];
  stateHintEl.textContent = copy[1];
}

function showError(title, hint) {
  setState("error", [title, hint]);
}

// Show an error and hang up, so the mic and timer don't keep running in a dead call.
function failCall(title, hint) {
  showError(title, hint);
  userEnded = true;
  room?.disconnect();
}

function startClock() {
  const startedAt = Date.now();
  timerEl.hidden = false;
  const tick = () => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    timerEl.textContent = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  };
  tick();
  clockTimer = setInterval(tick, 1000);
}

function setMicUI(enabled) {
  appEl.classList.toggle("is-muted", !enabled);
  micBtn.setAttribute("aria-pressed", String(!enabled));
  micLabelEl.textContent = enabled ? "Mic on" : "Muted";
}

// ---------- Transcript ----------

function upsertSegment(segmentId, speaker, text, append) {
  let textEl = segments.get(segmentId);
  if (!textEl) {
    transcriptEl.querySelector(".transcript-empty")?.remove();
    const msg = document.createElement("div");
    msg.className = `msg msg-${speaker}`;
    const who = document.createElement("span");
    who.className = "msg-who";
    who.textContent = speaker === "user" ? "You" : "Assistant";
    textEl = document.createElement("p");
    textEl.className = "msg-text";
    msg.append(who, textEl);
    transcriptEl.appendChild(msg);
    segments.set(segmentId, textEl);
  }
  textEl.textContent = append ? textEl.textContent + text : text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function handleTranscription(reader, participantInfo) {
  const segmentId = reader.info.attributes?.[ATTR_SEGMENT_ID] ?? reader.info.id;
  const isUser = participantInfo.identity === room.localParticipant.identity;

  try {
    if (isUser) {
      // User transcripts arrive as one short stream per update, each carrying the full text.
      // Updates are read concurrently, so skip one that finishes after a newer one was shown.
      const text = await reader.readAll();
      if (reader.info.timestamp < (userSegmentTimes.get(segmentId) ?? 0)) return;
      userSegmentTimes.set(segmentId, reader.info.timestamp);
      upsertSegment(segmentId, "user", text, false);
    } else {
      // Agent transcripts arrive as one stream per reply, delivered as text deltas.
      for await (const chunk of reader) {
        upsertSegment(segmentId, "agent", chunk, true);
      }
    }
  } catch (err) {
    // A stream cut off mid-read (e.g. the call ended) leaves that line partial.
    console.warn("transcription stream ended early", err);
  }
}

// ---------- Agent ----------

function trackAgent(participant) {
  if (!participant.isAgent) return;
  agentParticipant = participant;
  clearTimeout(joinTimer);
  setState(participant.attributes[ATTR_AGENT_STATE] in STATE_COPY ? participant.attributes[ATTR_AGENT_STATE] : "initializing");
}

function onAgentState(state) {
  if (state in STATE_COPY) setState(state);
}

// ---------- Audio levels ----------

// Visualizer: mirror voice-range frequency bands out from the centre bar.
const freqData = new Uint8Array(128);
const half = Math.ceil(BAR_COUNT / 2);

function renderLevels() {
  if (agentAnalyser && currentState === "speaking") {
    agentAnalyser.analyser.getByteFrequencyData(freqData);
    const bandWidth = 3; // ~180 Hz per bin at fftSize 256 / 48 kHz; bands cover the voice range
    for (let i = 0; i < BAR_COUNT; i++) {
      const band = Math.abs(i - (half - 1));
      let sum = 0;
      for (let b = 0; b < bandWidth; b++) sum += freqData[1 + band * bandWidth + b];
      bars[i].style.setProperty("--h", (sum / bandWidth / 255).toFixed(3));
    }
  } else {
    bars.forEach((bar) => bar.style.setProperty("--h", 0));
  }

  const micLevel = micAnalyser ? micAnalyser.calculateVolume() : 0;
  micBtn.style.setProperty("--mic", micLevel.toFixed(3));
  // The analyser reads a cloned track, so it still hears you while muted.
  appEl.classList.toggle("is-talking-muted", appEl.classList.contains("is-muted") && micLevel > 0.35);

  frame = requestAnimationFrame(renderLevels);
}

// ---------- Call lifecycle ----------

async function startCall() {
  userEnded = false;
  segments.clear();
  userSegmentTimes.clear();
  transcriptEl.replaceChildren(transcriptPlaceholder.cloneNode(true));
  callBtn.disabled = true;
  setState("connecting");

  let tokenData;
  try {
    const res = await fetch("/api/token", { method: "POST" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    tokenData = await res.json();
  } catch (err) {
    console.error(err);
    showError("Couldn't start the call", "The token server didn't respond. Check that uvicorn is running, then try again.");
    resetCall();
    return;
  }

  room = new Room();
  room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, handleTranscription);
  room
    .on(RoomEvent.ParticipantConnected, trackAgent)
    .on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      if (participant.isAgent && ATTR_AGENT_STATE in changed) onAgentState(changed[ATTR_AGENT_STATE]);
    })
    .on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant !== agentParticipant) return;
      agentParticipant = null;
      failCall("The assistant left the call", "Check the terminal running lk agent dev for errors, then start a new call.");
    })
    .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      audioContainer.appendChild(track.attach());
      if (participant.isAgent) {
        agentAnalyser = createAudioAnalyser(track, { fftSize: 256, smoothingTimeConstant: 0.7, minDecibels: -90, maxDecibels: -20 });
      }
    })
    .on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
      track.detach().forEach((el) => el.remove());
      if (participant.isAgent && agentAnalyser) {
        agentAnalyser.cleanup();
        agentAnalyser = null;
      }
    })
    .on(RoomEvent.Disconnected, () => {
      if (!userEnded && currentState !== "error") {
        showError("Connection lost", "Check that livekit-server is still running, then start a new call.");
      }
      resetCall();
    });

  try {
    await room.connect(tokenData.server_url, tokenData.token);
  } catch (err) {
    console.error(err);
    showError("Can't reach the LiveKit server", "Check that livekit-server --dev is running, then try again.");
    resetCall();
    return;
  }

  try {
    await room.localParticipant.setMicrophoneEnabled(true);
    const micTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (micTrack) {
      micAnalyser = createAudioAnalyser(micTrack, { cloneTrack: true, minDecibels: -80, maxDecibels: -25 });
    }
  } catch (err) {
    console.error(err);
    showError("Microphone blocked", "Allow microphone access in your browser's address bar, then start the call again.");
    userEnded = true;
    await room.disconnect();
    return;
  }

  appEl.classList.add("in-call");
  appEl.title = `Room ${tokenData.room}`;
  callBtn.textContent = "End call";
  callBtn.disabled = false;
  micBtn.disabled = false;
  setMicUI(true);
  startClock();
  renderLevels();

  // The agent may already be in the room by the time we finish connecting.
  room.remoteParticipants.forEach(trackAgent);
  if (!agentParticipant) {
    setState("waiting");
    joinTimer = setTimeout(() => {
      if (!agentParticipant) {
        failCall("The assistant didn't join", "Check the terminal running lk agent dev for errors, then start a new call.");
      }
    }, AGENT_JOIN_TIMEOUT_MS);
  }
}

function endCall() {
  userEnded = true;
  micBtn.disabled = true;
  callBtn.disabled = true;
  setState("ended");
  room?.disconnect();
}

function resetCall() {
  cancelAnimationFrame(frame);
  clearTimeout(joinTimer);
  clearInterval(clockTimer);
  agentAnalyser?.cleanup();
  micAnalyser?.cleanup();
  agentAnalyser = micAnalyser = null;
  room = null;
  agentParticipant = null;
  audioContainer.replaceChildren();
  bars.forEach((bar) => bar.style.setProperty("--h", 0));
  appEl.classList.remove("in-call", "is-muted", "is-talking-muted");
  appEl.removeAttribute("title");
  timerEl.hidden = true;
  callBtn.textContent = "Start call";
  callBtn.disabled = false;
  micBtn.disabled = true;
  micBtn.style.setProperty("--mic", 0);
  setMicUI(true);
  micLabelEl.textContent = "Mic";
}

callBtn.addEventListener("click", () => (room ? endCall() : startCall()));

micBtn.addEventListener("click", async () => {
  const participant = room.localParticipant;
  micBtn.disabled = true;
  try {
    await participant.setMicrophoneEnabled(!participant.isMicrophoneEnabled);
  } catch (err) {
    console.error(err);
  }
  if (!room) return; // the call ended while toggling; resetCall already set the UI
  // Reflect the mic's real state, whether or not the toggle succeeded.
  setMicUI(participant.isMicrophoneEnabled);
  micBtn.disabled = false;
});
