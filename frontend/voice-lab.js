// Voice Lab: draws the per-turn latency report published by backend/voice_lab.py.
// Each stage is measured by LiveKit; stages overlap, so they don't sum to the total.
const VoiceLab = (() => {
  const TOPIC = "voice-lab.turn";
  const HISTORY_SIZE = 5;
  const STAGES = [
    ["end_of_turn", "Turn detection"],
    ["transcription", "Transcription"],
    ["llm_ttft", "LLM first token"],
    ["tts_ttfb", "TTS first audio"],
  ];
  const STORAGE_KEY = "voice-lab-visible";

  const panelEl = document.getElementById("lab");
  const toggleBtn = document.getElementById("lab-toggle");
  const totalEl = document.getElementById("lab-total");
  const stagesEl = document.getElementById("lab-stages");
  const historyEl = document.getElementById("lab-history");
  const decoder = new TextDecoder();
  let history = [];

  const formatMs = (seconds) => (seconds == null ? "—" : `${Math.round(seconds * 1000)} ms`);

  function render(report) {
    totalEl.textContent = formatMs(report.e2e);
    const scale = Math.max(report.e2e ?? 0, ...STAGES.map(([key]) => report[key] ?? 0)) || 1;

    stagesEl.replaceChildren(
      ...STAGES.map(([key, label]) => {
        const row = document.createElement("div");
        row.className = "lab-row";
        const name = document.createElement("span");
        name.className = "lab-name";
        name.textContent = label;
        const track = document.createElement("span");
        track.className = "lab-track";
        const bar = document.createElement("span");
        bar.className = "lab-bar";
        bar.style.width = `${((report[key] ?? 0) / scale) * 100}%`;
        track.appendChild(bar);
        const value = document.createElement("span");
        value.className = "lab-value";
        value.textContent = formatMs(report[key]);
        row.append(name, track, value);
        return row;
      }),
    );

    if (report.e2e != null) {
      history = [report.e2e, ...history].slice(0, HISTORY_SIZE);
      historyEl.textContent = `Last ${history.length}: ${history.map(formatMs).join(", ")}`;
    }
  }

  function reset() {
    history = [];
    totalEl.textContent = "—";
    historyEl.textContent = "";
    stagesEl.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "lab-empty";
    empty.textContent = "Talk to the assistant to see how long each reply takes.";
    stagesEl.appendChild(empty);
  }

  // Ignores data messages on other topics.
  function handleData(payload, topic) {
    if (topic !== TOPIC) return;
    try {
      render(JSON.parse(decoder.decode(payload)));
    } catch (err) {
      console.warn("invalid voice lab report", err);
    }
  }

  function setVisible(visible) {
    panelEl.hidden = !visible;
    toggleBtn.setAttribute("aria-pressed", String(visible));
    try {
      localStorage.setItem(STORAGE_KEY, visible ? "1" : "0");
    } catch {
      // Storage can be blocked (private mode); the toggle still works for this visit.
    }
  }

  toggleBtn.addEventListener("click", () => setVisible(panelEl.hidden));

  let initiallyVisible = true;
  try {
    initiallyVisible = localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    // Fall back to showing the panel.
  }
  setVisible(initiallyVisible);
  reset();

  return { handleData, reset };
})();
