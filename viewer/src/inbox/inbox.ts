// The inbox page's script: group, sort, filter and search the rows the daemon rendered, the menus, live reloads,
// archive and delete, and the reader's menu. A plain script, not part of the app: vite.config.ts compiles it, and the
// daemon puts it at the end of the inbox page, after its data (InboxData) in a JSON block.
import type Fuse from "fuse.js";
import type { Identity, InboxData, RepoAvatar } from "../../../skill/schema/types";

(() => {
  const data = JSON.parse(document.getElementById("inbox-data")!.textContent!) as InboxData;
  const { phases: PHASES, tags: TAGS, folderIcon: FOLDER, shown, token, me: ME, daemon: DAEMON } = data;

  // A browser that never saw the setup page (see viewer/src/lib/setup.ts) is offered it once, here and above a report.
  try {
    const hint = document.getElementById("setup-hint")!;
    if (!localStorage.getItem("pr-report:setup")) {
      hint.hidden = false;
      document.getElementById("setup-dismiss")!.onclick = () => {
        localStorage.setItem("pr-report:setup", JSON.stringify({ at: new Date().toISOString() }));
        hint.hidden = true;
      };
    }
  } catch {}
  const ago = (t: string) => {
    const s = (Date.now() - Date.parse(t)) / 1000;
    return s < 60 ? "now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " d ago";
  };
  for (const el of document.querySelectorAll("time")) el.textContent = ago(el.dataset.at!);
  const WAITING = ["reviewing", "planning"];
  const LABELS: Record<"group" | "sort", Record<string, string>> = {
    group: { owner: "Owner", repo: "Repo", status: "Status", type: "Type", none: "None" },
    sort: { activity: "Recent activity", waiting: "Waiting on you", title: "Title" },
  };
  // Group, sort and filter happen here, on the rows the server sent. The choice is remembered in this browser.
  const prefs: { group: string; sort: string; phase: string[]; tag: string[] } = { group: "owner", sort: "activity", phase: [], tag: [] };
  try {
    const saved = JSON.parse(localStorage.getItem("pr-report-inbox") || "{}") as Record<string, unknown>;
    if (LABELS.group[saved.group as string]) prefs.group = saved.group as string;
    if (LABELS.sort[saved.sort as string]) prefs.sort = saved.sort as string;
    for (const k of ["phase", "tag"] as const) if (Array.isArray(saved[k])) prefs[k] = saved[k] as string[];
  } catch {}
  // A saved filter for a status or tag no review has any more would hide everything with nothing to untick.
  for (const k of ["phase", "tag"] as const) {
    const offered = [...document.querySelectorAll<HTMLInputElement>("input[name=" + k + "]")].map((i) => i.value);
    prefs[k] = prefs[k].filter((v) => offered.includes(v));
  }
  const save = () => {
    try {
      localStorage.setItem("pr-report-inbox", JSON.stringify(prefs));
    } catch {}
  };
  // The search lasts for this tab, through the reloads that new events cause, but not into the next visit.
  let query = "";
  try {
    query = sessionStorage.getItem("pr-report-inbox-q") || "";
  } catch {}
  const searchBox = document.querySelector<HTMLInputElement>("input[name=q]");
  if (searchBox) searchBox.value = query;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string | null) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const boxes = [...document.querySelectorAll<HTMLElement>("[data-rows]")].map((box) => ({ box, rows: [...box.querySelectorAll<HTMLElement>(".row")] }));
  const at = (r: HTMLElement) => r.dataset.updated!;
  const rank = (list: string[], k: string) => {
    const i = list.indexOf(k);
    return i < 0 ? list.length : i;
  };
  const SORTS: Record<string, (a: HTMLElement, b: HTMLElement) => number> = {
    activity: (a, b) => at(b).localeCompare(at(a)),
    waiting: (a, b) => Number(WAITING.includes(b.dataset.phase!)) - Number(WAITING.includes(a.dataset.phase!)) || at(b).localeCompare(at(a)),
    title: (a, b) => a.dataset.title!.localeCompare(b.dataset.title!, undefined, { sensitivity: "base" }),
  };
  const KEYS: Record<string, (r: HTMLElement) => string> = {
    owner: (r) => r.dataset.owner!,
    repo: (r) => r.dataset.repo!,
    status: (r) => r.dataset.phase!,
    type: (r) => r.dataset.tag!,
    none: () => "",
  };
  const nameOf = (k: string) => (prefs.group === "owner" && !k ? "Local repos" : k);
  // Fuzzy search with Fuse.js over title, repo and branch. Until it loads, or if it cannot, a plain substring match.
  const items = boxes
    .flatMap((b) => b.rows)
    .map((row) => ({ row, title: row.dataset.title!, repo: row.dataset.repo!, branch: row.dataset.branch! }));
  let fuse: Fuse<(typeof items)[number]> | null = null;
  let hits: Set<HTMLElement> | null = null;
  const search = () => {
    const q = query.trim();
    hits = !q
      ? null
      : new Set(
          fuse
            ? fuse.search(q).map((x) => x.item.row)
            : items.filter((i) => (i.title + " " + i.repo + " " + i.branch).toLowerCase().includes(q.toLowerCase())).map((i) => i.row),
        );
  };
  // "View All Reports for <owner>" on a review page links here with ?owner=, to show only that owner's reviews.
  const onlyOwner = new URLSearchParams(location.search).get("owner");
  const left = document.querySelector(".bar .left");
  // It starts a fresh look at that owner, so a search left from earlier in this tab does not hide their reviews.
  if (onlyOwner !== null) {
    query = "";
    try {
      sessionStorage.removeItem("pr-report-inbox-q");
    } catch {}
    if (searchBox) searchBox.value = "";
  }
  if (onlyOwner !== null && left) {
    const chip = make("span", "only", "Owner: " + (onlyOwner || "Local repos")),
      x = make("a", "", "×");
    x.href = "/";
    x.title = "Show every owner";
    x.setAttribute("aria-label", "Show every owner");
    chip.append(x);
    left.append(chip);
  }
  const matches = (r: HTMLElement) =>
    (onlyOwner === null || r.dataset.owner === onlyOwner) &&
    (!prefs.phase.length || prefs.phase.includes(r.dataset.phase!)) &&
    (!prefs.tag.length || prefs.tag.includes(r.dataset.tag!)) &&
    (!hits || hits.has(r));
  function heading(key: string, first: HTMLElement, count: number) {
    const h = make("h2", "gh");
    if (prefs.group === "owner" || prefs.group === "repo") {
      let av = first.querySelector(".av")?.cloneNode(true) as Element | undefined;
      if (prefs.group === "owner" && !key) {
        av = make("span", "av local");
        av.innerHTML = FOLDER;
      }
      if (av) h.append(av);
      h.append(make("span", "", nameOf(key)));
    } else if (prefs.group === "status") {
      const dot = make("span", "dot");
      dot.style.background = (PHASES[key] ?? [])[1] ?? "#71717a";
      h.append(dot, (PHASES[key] ?? [key])[0]);
    } else h.append(first.querySelector(".tag")!.cloneNode(true));
    h.append(make("span", "count", String(count)));
    return h;
  }
  function render() {
    document.body.dataset.group = prefs.group;
    for (const { box, rows } of boxes) {
      if (!rows.length) continue;
      const kept = rows.filter(matches).sort(SORTS[prefs.sort]),
        groups = new Map<string, HTMLElement[]>();
      for (const r of kept) {
        const k = KEYS[prefs.group](r);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
      }
      const order = [...groups.keys()];
      if (prefs.group === "status") order.sort((a, b) => rank(Object.keys(PHASES), a) - rank(Object.keys(PHASES), b));
      else if (prefs.group === "type") order.sort((a, b) => rank(TAGS, a) - rank(TAGS, b));
      else if (prefs.sort === "title") order.sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" }));
      box.replaceChildren(
        ...order.map((k) => {
          const section = make("section", "group"),
            list = make("div", "list");
          if (prefs.group !== "none") section.append(heading(k, groups.get(k)![0], groups.get(k)!.length));
          list.append(...groups.get(k)!);
          section.append(list);
          return section;
        }),
      );
      if (!kept.length) {
        const list = make("div", "list"),
          empty = make("div", "empty", "No reviews match these filters."),
          clear = make("button", "clear-all", "Clear filters");
        clear.type = "button";
        empty.append(clear);
        list.append(empty);
        box.append(list);
      }
    }
    const active = boxes[0].rows,
      visible = active.filter(matches),
      shown = visible.length,
      waiting = visible.filter((r) => WAITING.includes(r.dataset.phase!)).length;
    const summary = document.getElementById("summary");
    if (summary)
      summary.textContent =
        (shown === active.length ? active.length + " " + (active.length === 1 ? "review" : "reviews") : shown + " of " + active.length + " reviews") +
        (waiting ? ", " + waiting + " waiting on you" : "");
    for (const i of document.querySelectorAll<HTMLInputElement>(".menu input[type=radio],.menu input[type=checkbox]"))
      i.checked = i.type === "radio" ? prefs[i.name as "group" | "sort"] === i.value : prefs[i.name as "phase" | "tag"].includes(i.value);
    for (const k of ["group", "sort"] as const) {
      const b = document.querySelector("[data-label=" + k + "]");
      if (b) b.textContent = LABELS[k][prefs[k]];
    }
    const n = prefs.phase.length + prefs.tag.length + (query.trim() ? 1 : 0),
      f = document.querySelector("[data-label=filter]");
    if (f) {
      f.textContent = n ? String(n) : "";
      f.className = n ? "badge" : "";
    }
  }
  search();
  render();
  // Fuse.js is served by the daemon (/fuse.mjs), not bundled here. The address is a variable so TypeScript does not
  // look for it as a module.
  const fuseUrl = "/fuse.mjs";
  (import(fuseUrl) as Promise<{ default: typeof Fuse }>)
    .then(({ default: FuseClass }) => {
      fuse = new FuseClass(items, { keys: [{ name: "title", weight: 2 }, "repo", "branch"], threshold: 0.35, ignoreLocation: true });
      search();
      render();
    })
    .catch(() => {});
  const setQuery = (q: string) => {
    query = q;
    try {
      sessionStorage.setItem("pr-report-inbox-q", q);
    } catch {}
    search();
    render();
  };
  document.addEventListener("input", (e) => {
    if (searchBox && e.target === searchBox) setQuery(searchBox.value);
  });
  // Menus: one open at a time; a click outside or Escape closes them.
  const dds = [...document.querySelectorAll<HTMLElement>(".dd")],
    openMenu = () => dds.find((d) => !d.querySelector<HTMLElement>(".menu")!.hidden);
  const toggle = (dd: Element, open: boolean) => {
    dd.querySelector<HTMLElement>(".menu")!.hidden = !open;
    dd.querySelector("[aria-haspopup]")!.setAttribute("aria-expanded", String(open));
    if (open && searchBox && dd.contains(searchBox)) searchBox.focus();
  };
  let reloadLater = false;
  document.addEventListener("click", (e) => {
    const target = e.target as Element;
    const dd = target.closest(".dd");
    for (const d of dds) if (d !== dd) toggle(d, false);
    if (dd && target.closest("[aria-haspopup]")) toggle(dd, Boolean(dd.querySelector<HTMLElement>(".menu")!.hidden));
    if (target.closest(".clear,.clear-all")) {
      prefs.phase = [];
      prefs.tag = [];
      save();
      if (searchBox) searchBox.value = "";
      setQuery("");
    }
    if (reloadLater && !openMenu()) location.reload();
  });
  // "/" opens the filter menu at the search box, as on GitHub.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || (e.target as Element).closest("input,textarea") || !searchBox) return;
    e.preventDefault();
    for (const d of dds) toggle(d, d.contains(searchBox));
  });
  document.addEventListener("keydown", (e) => {
    const d = openMenu();
    if (e.key === "Escape" && d) {
      toggle(d, false);
      d.querySelector<HTMLElement>("[aria-haspopup]")!.focus();
      if (reloadLater) location.reload();
    }
  });
  document.addEventListener("change", (e) => {
    const i = e.target as HTMLInputElement;
    if (!(i.name in prefs)) return;
    if (i.type === "radio") {
      prefs[i.name as "group" | "sort"] = i.value;
      toggle(i.closest(".dd")!, false);
    } else prefs[i.name as "phase" | "tag"] = [...document.querySelectorAll<HTMLInputElement>("input[name=" + i.name + "]:checked")].map((x) => x.value);
    save();
    render();
  });
  // The stream starts with every review's current state, so reload only for a review that changed or is new.
  const es = new EventSource(`/api/events?token=${token}&watch=*`);
  let t: ReturnType<typeof setTimeout> | undefined;
  es.addEventListener("state", (e) => {
    const s = JSON.parse(e.data) as { id: string; updatedAt: string };
    if (shown[s.id] === s.updatedAt) return;
    clearTimeout(t);
    t = setTimeout(() => (openMenu() ? (reloadLater = true) : location.reload()), 400);
  });
  document.addEventListener("click", async (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button[data-act]");
    if (!b) return;
    if (b.dataset.act === "delete" && !confirm("Delete this review's files (" + b.dataset.size + ") and its saved rounds? This cannot be undone. Your code and branches are not touched."))
      return;
    const act = b.dataset.act === "delete" ? "delete" : "archive";
    const res = await fetch("/api/r/" + encodeURIComponent(b.dataset.id!) + "/" + act, {
      method: "POST",
      headers: { "x-review-token": token, "content-type": "application/json" },
      body: JSON.stringify({ archived: b.dataset.act !== "restore" }),
    });
    if (!res.ok) alert(((await res.json().catch(() => ({}))) as { error?: string }).error || "Could not do that");
    location.reload();
  });
  // The reader's menu in the top bar, with the options a report's menu has (viewer/src/components/UserMenu.tsx): who is
  // reading, the profile, Settings, Help, a bug report, the cache purge and the daemon. A change to one menu needs the
  // same change to the other.
  const SOURCES: Record<string, string> = { gh: "via the GitHub CLI", glab: "via the GitLab CLI", git: "from git config", none: "no identity found" };
  // Draws an avatar into the element with this id, as a picture or as initials on a color, whichever it was before.
  const paint = (id: string, a: RepoAvatar | null | undefined) => {
    let el = document.getElementById(id);
    if (!el || !a) return;
    const swap = (tag: string) => {
      if (el!.tagName === tag) return;
      const n = document.createElement(tag);
      n.id = id;
      n.className = el!.className;
      el!.replaceWith(n);
      el = n;
    };
    if (String(a.image || "").startsWith("data:image/")) {
      swap("IMG");
      (el as HTMLImageElement).alt = "";
      (el as HTMLImageElement).src = a.image!;
      return;
    }
    swap("SPAN");
    el.style.background = /^#[0-9a-f]{6}$/i.test(a.color || "") ? a.color : "#71717a";
    el.textContent = String(a.initials || "").slice(0, 2);
  };
  const showMe = (who: Identity) => {
    document.getElementById("me-name")!.textContent = who.name || who.login || who.email || "Unknown";
    document.getElementById("me-sub")!.textContent = (who.login ? "@" + who.login : who.email || "") + (who.login || who.email ? " · " : "") + SOURCES[who.source];
    for (const id of ["me-face", "me-face-big"]) paint(id, who.avatar);
    if (who.url) {
      const p = document.getElementById("me-profile") as HTMLAnchorElement,
        forge = ({ github: "GitHub ", gitlab: "GitLab " } as Record<string, string>)[ME.forge] || "";
      p.href = who.url;
      p.querySelector("span")!.textContent = "Open " + forge + "profile";
      p.hidden = false;
    }
  };
  // The last answer is kept in the browser and drawn at once, so the avatar is there at the first paint and does not
  // pop in a moment later on every page. A report keeps and reads the same entry (viewer/src/lib/identity.ts).
  const ME_KEY = ME.host + "|" + ME.forge + "|" + ME.root;
  try {
    const kept = JSON.parse(localStorage.getItem("pr-report:me") || "null") as { key?: string; who?: Identity } | null;
    if (kept && kept.key === ME_KEY && kept.who) showMe(kept.who);
  } catch {}
  fetch("/api/me?" + new URLSearchParams(ME), { headers: { "x-review-token": token } })
    .then((r) => (r.ok ? (r.json() as Promise<Identity>) : null))
    .catch(() => null)
    .then((who) => {
      if (!who) {
        if (document.getElementById("me-name")!.textContent === "Looking you up…") document.getElementById("me-name")!.textContent = "Unknown";
        return;
      }
      showMe(who);
      try {
        localStorage.setItem("pr-report:me", JSON.stringify({ key: ME_KEY, who }));
      } catch {}
    });
  // "<" and "!--" are kept apart: this script sits inside the page's HTML, where the two together start a comment.
  (document.getElementById("me-bug") as HTMLAnchorElement).href +=
    "?" +
    new URLSearchParams({
      body: ["<" + "!-- What happened, and what you expected --" + ">", "", "", "---", "Reflektor daemon " + DAEMON.version + ", Node " + DAEMON.node, "Browser: " + navigator.userAgent].join(
        "\n",
      ),
    });
  // Settings, Help and the cache purge are the report's own dialogs. They are not written a second time here: the page
  // at /panel holds them, and it is loaded in a see-through frame over the window (viewer/src/lib/panel.ts). The frame
  // is fetched when the menu first opens, so a dialog is there at once when it is asked for. A theme picked in Settings
  // reaches this page through the storage event the script in the head listens to.
  let panel: HTMLIFrameElement | null = null,
    panelReady = false,
    wanted: string | null = null;
  const loadPanel = () => {
    if (panel) return;
    panel = document.createElement("iframe");
    panel.className = "panel";
    panel.title = "Settings, help and the cache";
    panel.hidden = true;
    panel.src = "/panel";
    document.body.append(panel);
  };
  const showPanel = () => {
    if (!panelReady || !wanted) return;
    panel!.hidden = false;
    panel!.contentWindow!.postMessage({ open: wanted }, location.origin);
    panel!.focus();
  };
  const openPanel = (name: string) => {
    wanted = name;
    loadPanel();
    showPanel();
  };
  addEventListener("message", (e) => {
    if (!panel || e.origin !== location.origin || e.source !== panel.contentWindow || !e.data) return;
    if (e.data.panel === "ready") {
      panelReady = true;
      showPanel();
    }
    if (e.data.panel === "closed" && !panel.hidden) {
      panel.hidden = true;
      wanted = null;
      document.querySelector<HTMLElement>(".who")!.focus();
    }
  });
  document.querySelector(".who")!.addEventListener("click", loadPanel);
  document.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-panel]");
    if (!b) return;
    toggle(b.closest(".dd")!, false);
    openPanel(b.dataset.panel!);
  });
  document.addEventListener("click", (e) => {
    if (!(e.target as Element).closest("[data-settings]")) return;
    location.href = "/settings";
  });
  // "?" opens Settings, as in a report.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey || (e.target as Element).closest("input,textarea")) return;
    e.preventDefault();
    location.href = "/settings";
  });
  // How long the daemon has run, worded as in the report's menu: its two largest units, never rounded up.
  const upFor = (since: string) => {
    const s = (Date.now() - Date.parse(since)) / 1000;
    if (s < 90) return "just started";
    const m = Math.floor(s / 60),
      d = Math.floor(m / 1440),
      h = Math.floor((m % 1440) / 60),
      min = m % 60;
    return "up " + (d ? [d + "d", h > 0 && h + "h"] : h ? [h + "h", min > 0 && min + "min"] : [min + "min"]).filter(Boolean).join(" ");
  };
  const status = document.getElementById("me-status")!;
  let daemonUp = true;
  const showStatus = () => {
    status.classList.toggle("down", !daemonUp);
    status.lastElementChild!.textContent = daemonUp ? "Daemon up · " + DAEMON.version.slice(0, 7) + " · " + upFor(DAEMON.startedAt) : "Daemon unavailable";
  };
  showStatus();
  es.addEventListener("open", () => {
    daemonUp = true;
    showStatus();
  });
  es.addEventListener("error", () => {
    daemonUp = false;
    showStatus();
  });
  document.querySelector(".who")!.addEventListener("click", showStatus);
})();
