// Inverse of content.js idleToPhase: phase 0–4 → idle ms, so the slider can
// drive the exact same continuous phase the idle timer would produce.
function phaseToIdleMs(phase) {
  const p = Math.max(0, Math.min(4, phase));
  let m;
  if (p < 1)      m = p * 10;
  else if (p < 2) m = 10 + (p - 1) * 50;
  else if (p < 3) m = 60 + (p - 2) * 420;
  else            m = 480 + (p - 3) * 480;
  return Math.round(m * 60000);
}

async function sendIdle(idleMs, label) {
  const status = document.getElementById("status");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { status.textContent = "找不到分頁"; return; }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "ARACHNE_IDLE_DURATION", idleMs, label });
    status.textContent = `✓ ${label}`;
  } catch {
    status.textContent = "請先重新整理該分頁";
  }
}

// Phase slider: scrub the continuous 0–4 phase live and watch it rebuild.
const slider = document.getElementById("phase");
const phaseLabel = document.getElementById("phaseLabel");
slider.addEventListener("input", () => {
  const phase = parseFloat(slider.value);
  phaseLabel.textContent = `階段 ${phase.toFixed(2)}`;
  sendIdle(phaseToIdleMs(phase), `階段 ${phase.toFixed(2)}`);
});

document.querySelectorAll("button[data-ms]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const idleMs = parseInt(btn.dataset.ms, 10);
    const label = btn.textContent.trim();
    const status = document.getElementById("status");

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { status.textContent = "找不到分頁"; return; }

    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "ARACHNE_IDLE_DURATION",
        idleMs,
        label,
      });
      status.textContent = `✓ ${label}`;
    } catch {
      status.textContent = "請先重新整理該分頁";
    }
  });
});
