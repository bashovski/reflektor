// The inbox's theme: the one the review page saved (pr-report:theme, as in src/boot/theme.ts), applied before the
// first paint, so the inbox and the review page agree even when the system is set the other way. "system" follows
// the OS and changes with it, and a theme picked in a review page tab reaches an open inbox through the storage event.
// A plain script: vite.config.ts compiles it, and the daemon puts it into the inbox's head.
(() => {
  let saved: unknown = "system";
  const read = (value: string | null) => {
    try {
      saved = JSON.parse(value ?? '"system"');
    } catch {
      saved = "system";
    }
  };
  read(localStorage.getItem("pr-report:theme"));
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.dataset.theme = saved === "dark" || saved === "light" ? saved : mq.matches ? "dark" : "light";
  };
  apply();
  mq.addEventListener("change", apply);
  addEventListener("storage", (e) => {
    if (e.key === "pr-report:theme") {
      read(e.newValue);
      apply();
    }
  });
})();
