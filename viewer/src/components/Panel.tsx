import { useCallback, useEffect, useRef, useState } from "react";
import { describeAgent } from "../lib/agent";
import type { PanelName } from "../lib/panel";
import { HelpPanel } from "./Help";
import { UpdateDialog } from "./UpdateDialog";
import { PurgeDialog } from "./UserMenu";

const NAMES: PanelName[] = ["help", "purge", "update"];

// The page behind /panel (see lib/panel.ts): nothing but the dialogs, over a see-through page. The page that frames
// this one says which dialog to open, and hears back when it is closed so it can put the frame away. Both sides
// listen to their own origin only.
export const Panel = () => {
  const [open, setOpen] = useState<PanelName | null>(null);
  // The dialog that is open now, for the close handlers, which must not act on old news (see closeOf).
  const current = useRef<PanelName | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("panel");
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== window.parent) return;
      const name = (e.data as { open?: unknown } | null)?.open as PanelName;
      if (!NAMES.includes(name)) return;
      current.current = name;
      setOpen(name);
    };
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ panel: "ready" }, window.location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // A dialog reports its closing more than once: the button that closes it does, and then the browser's own close
  // event does. That event can arrive late. A browser holds it back while the frame is hidden, which it is as soon
  // as the first report reaches the page around it. Delivered after the next dialog has opened, it would close that
  // one. So a close counts only for the dialog that is open now, and a close event from a dialog that is open again
  // is the late one and is dropped.
  const closeOf = useCallback(
    (name: PanelName) => (e?: unknown) => {
      if (current.current !== name) return;
      const event = e as { type?: string; currentTarget?: HTMLDialogElement } | undefined;
      if (event?.type === "close" && event.currentTarget?.open) return;
      current.current = null;
      setOpen(null);
      window.parent.postMessage({ panel: "closed" }, window.location.origin);
    },
    [],
  );

  return (
    <>
      {/* There is no review here to name an agent, so Help speaks of "your agent". */}
      <HelpPanel open={open === "help"} onClose={closeOf("help")} agent={describeAgent(null)} />
      <PurgeDialog open={open === "purge"} onClose={closeOf("purge")} />
      {/* No event stream here: the dialog asks the daemon itself. */}
      <UpdateDialog open={open === "update"} info={null} onClose={closeOf("update")} />
    </>
  );
};
