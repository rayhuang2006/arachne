(function () {
  if (document.getElementById("arachne-canvas")) return;

  const canvas = document.createElement("canvas");
  canvas.id = "arachne-canvas";

  Object.assign(canvas.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    zIndex: "2147483647",
    pointerEvents: "none",
  });

  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");

  // Phase-1 marker: red triangle in the top-right corner
  const m = 48; // margin from edge
  ctx.beginPath();
  ctx.moveTo(canvas.width - m, m / 2);
  ctx.lineTo(canvas.width - m / 2, m);
  ctx.lineTo(canvas.width - m * 1.5, m);
  ctx.closePath();
  ctx.fillStyle = "rgba(220, 38, 38, 0.85)";
  ctx.fill();
  // Phase 2: receive idle duration from background worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "ARACHNE_IDLE_DURATION") {
      console.log(`[Arachne] 這個分頁閒置了 ${msg.label}（${msg.idleMs} ms）`);
    }
  });
})();
