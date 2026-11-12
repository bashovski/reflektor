// The saved theme (see lib/state.tsx), applied before the first paint so a dark page never starts white.
// A plain script, not part of the app: vite.config.ts compiles it and puts it into index.html's head.
(() => {
  let saved: unknown = "system";
  try {
    saved = JSON.parse(localStorage.getItem("pr-report:theme") ?? '"system"');
  } catch {}
  const system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = saved === "dark" || saved === "light" ? saved : system;
})();
