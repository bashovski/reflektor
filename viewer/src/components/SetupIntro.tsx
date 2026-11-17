import { type CSSProperties, useEffect } from "react";
import { Logo } from "./ui";

// The opening of the setup page, after the end of the launch video: the mark grows in over the dither, shrinks and
// lifts while the tagline comes in word by word, the tagline leaves, then the mark fades as the wizard rises in its
// place. The timings are in index.css (.setup-intro-*); REVEAL_MS and END_MS match them. A click or a key skips it.
export const REVEAL_MS = 4500;
export const END_MS = 5300;

const TAGLINE = ["Code", "review", "on", "steroids."];

export const SetupIntro = ({ onReveal, onEnd }: { onReveal: () => void; onEnd: () => void }) => {
  useEffect(() => {
    const reveal = window.setTimeout(onReveal, REVEAL_MS);
    const end = window.setTimeout(onEnd, END_MS);
    return () => {
      window.clearTimeout(reveal);
      window.clearTimeout(end);
    };
  }, [onReveal, onEnd]);

  return (
    <div aria-hidden className="setup-intro fixed inset-0 z-10 cursor-pointer" onClick={onEnd}>
      <Logo className="setup-intro-logo text-[var(--text)]" />
      <p className="setup-intro-tagline">
        {TAGLINE.map((word, i) => (
          <span key={word} className="setup-intro-word" style={{ "--i": i } as CSSProperties}>
            {word}
          </span>
        ))}
      </p>
    </div>
  );
};
