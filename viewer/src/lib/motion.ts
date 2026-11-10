// Some readers ask their system for less motion. The stylesheet stops animations for them (see index.css); a
// scroll started from code has to ask here, since CSS cannot slow that one down.
export const scrollBehavior = (): ScrollBehavior => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");
