// The tab icon: a rounded square in the review's status color with a white glyph, plus a red dot
// when something happened while the reviewer was away. Drawn on a canvas and set as a PNG, since
// not every browser shows SVG icons.

export type TabIcon = "review" | "working" | "plan" | "done";

// Glyphs on a 24 px grid. Dots are zero-length lines that a wider round pen draws as circles.
// index.html carries the "review" icon as SVG, shown until this code runs.
const ICONS: Record<TabIcon, { color: string; lines?: string; dots?: string }> = {
  review: { color: "#2563eb", lines: "M20 14.5a2 2 0 0 1-2 2H8l-4 3.5V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" },
  working: { color: "#7c3aed", dots: "M6.5 12h.01M12 12h.01M17.5 12h.01" },
  plan: { color: "#d97706", lines: "M9.5 7h9M9.5 12h9M9.5 17h9", dots: "M5.5 7h.01M5.5 12h.01M5.5 17h.01" },
  done: { color: "#059669", lines: "M5.5 12.5l4 4 9-9" },
};

const SIZE = 64;

export function setFavicon(icon: TabIcon, dot: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { color, lines, dots } = ICONS[icon];

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(0, 0, SIZE, SIZE, 14);
  ctx.fill();

  ctx.save();
  ctx.translate(8, 8);
  ctx.scale(2, 2);
  ctx.strokeStyle = "#fff";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (lines) {
    ctx.lineWidth = 2.6;
    ctx.stroke(new Path2D(lines));
  }
  if (dots) {
    ctx.lineWidth = 3.6;
    ctx.stroke(new Path2D(dots));
  }
  ctx.restore();

  if (dot) {
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(SIZE - 14, 14, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(SIZE - 14, 14, 11, 0, Math.PI * 2);
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
