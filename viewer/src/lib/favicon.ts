// The tab icon: the Reflektor mark on a black square, the same base as the platform's favicon. A small badge in the
// top-right corner shows the review's status, and a red dot in the bottom-right corner shows that something happened
// while the reviewer was away. Drawn on a canvas and set as a PNG, since not every browser shows SVG icons.

export type TabIcon = "review" | "working" | "plan" | "done";

// Badge glyphs on a 24 px grid. Dots are zero-length lines that a wider round pen draws as circles.
const ICONS: Record<TabIcon, { color: string; lines?: string; dots?: string }> = {
  review: { color: "#2563eb", lines: "M20 14.5a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" },
  working: { color: "#7c3aed", dots: "M6.5 12h.01M12 12h.01M17.5 12h.01" },
  plan: { color: "#d97706", lines: "M9.5 7h9M9.5 12h9M9.5 17h9", dots: "M5.5 7h.01M5.5 12h.01M5.5 17h.01" },
  done: { color: "#059669", lines: "M5.5 12.5l4 4 9-9" },
};

// The mark from skill/brand/reflektor-logo.svg, on its 47 x 54 grid.
export const LOGO = {
  letter: "M24.7525 4.95049V9.90099H19.802V4.95049H24.7525V0H34.6535V4.95049H39.604V14.8515H29.703V4.95049H24.7525ZM24.7525 44.5545V49.5049H0V44.5545H4.9505V9.90099H0V4.95049H14.8515V9.90099H19.802V14.8515H14.8515V44.5545H24.7525Z",
  blob: "M46.0493 21.9025C40.1087 37.0018 46.3251 53.8367 39.4899 53.8367C32.6548 53.8367 19.3167 46.3122 19.3167 39.477C19.3167 32.6416 21.0211 31.3119 27.8563 31.3119C34.6914 31.3119 41.5939 17.4505 46.0493 21.9025Z",
  gradient: { from: [19.6879, 27.1008], to: [49.2671, 47.3976], stops: [[0.110577, "#9F81E4"], [0.302769, "#7D7AE2"], [0.539773, "#8D92E4"], [0.782594, "#C2E1CC"]] as const },
};

export const BASE_COLOR = "#09090b";

const SIZE = 64;

export function setFavicon(icon: TabIcon, dot: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { color, lines, dots } = ICONS[icon];

  ctx.fillStyle = BASE_COLOR;
  ctx.beginPath();
  ctx.roundRect(0, 0, SIZE, SIZE, 12);
  ctx.fill();

  // The mark sits lower left to leave the top-right corner to the badge.
  ctx.save();
  ctx.translate(8, 21);
  ctx.scale(0.63, 0.63);
  ctx.fillStyle = "#fafafa";
  ctx.fill(new Path2D(LOGO.letter));
  const { from, to, stops } = LOGO.gradient;
  const gradient = ctx.createLinearGradient(from[0], from[1], to[0], to[1]);
  for (const [offset, stop] of stops) gradient.addColorStop(offset, stop);
  ctx.fillStyle = gradient;
  ctx.fill(new Path2D(LOGO.blob));
  ctx.restore();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(47, 17, 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(47 - 9.6, 17 - 9.6);
  ctx.scale(0.8, 0.8);
  ctx.strokeStyle = "#fff";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (lines) {
    ctx.lineWidth = 3;
    ctx.stroke(new Path2D(lines));
  }
  if (dots) {
    ctx.lineWidth = 4.2;
    ctx.stroke(new Path2D(dots));
  }
  ctx.restore();

  if (dot) {
    ctx.fillStyle = BASE_COLOR;
    ctx.beginPath();
    ctx.arc(SIZE - 11, SIZE - 11, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(SIZE - 11, SIZE - 11, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/png";
  link.href = canvas.toDataURL("image/png");
}
