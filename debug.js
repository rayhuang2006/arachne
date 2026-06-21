// Runs in the page's MAIN world so DevTools console can access it directly.
// Bridges __arachneDebug() calls to the isolated content script via CustomEvent.
window.__arachneDebug = function (seconds) {
  window.dispatchEvent(
    new CustomEvent("arachne-debug", { detail: { seconds } }),
  );
};
