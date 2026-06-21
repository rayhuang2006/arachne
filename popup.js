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
