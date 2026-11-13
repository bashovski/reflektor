import { ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type PublishAnswer, publishReview, useReflektor } from "../lib/reflektor";

export type ReflektorAction = "sign-in" | "publish";

const button = "rounded-control border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-zinc-500/10 disabled:opacity-60";
const mainButton = "inline-flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent/85 disabled:opacity-60";

const Waiting = ({ children }: { children: string }) => (
  <p className="flex items-center gap-2 text-sm text-muted">
    <LoaderCircle aria-hidden className="size-4 animate-spin" />
    {children}
  </p>
);

// Signing in to Reflektor and publishing this review there, from the reader's menu. Signing in shows the code the
// approval page shows too, and waits until the reader approved it in the browser. Publishing starts as the dialog
// opens, and asks which organization when several of the reader's approve the repo. `api` is the review's
// (`/api/r/<id>`).
export const ReflektorDialog = ({ action, api, onAction, onClose }: { action: ReflektorAction | null; api: string; onAction: (a: ReflektorAction) => void; onClose: () => void }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const { status, refresh, signIn } = useReflektor(action !== null);
  const [answer, setAnswer] = useState<PublishAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publish = async (organization?: string) => {
    setBusy(true);
    setError(null);
    try {
      setAnswer(await publishReview(api, organization));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const startSignIn = () => {
    setError(null);
    signIn().catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    if (action && !ref.current?.open) ref.current?.showModal();
    if (!action && ref.current?.open) ref.current.close();
    setAnswer(null);
    setError(null);
    if (action === "publish") void publish();
    if (action !== "sign-in") return;
    // The daemon waits for the approval; the dialog asks it how that goes until it is closed.
    startSignIn();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
    // Runs when the dialog opens for an action; publish, signIn and refresh are the same functions each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action]);

  const who = status?.user ? (status.user.name ?? status.user.email) : null;
  const pending = status?.signIn;
  const choices = answer && !answer.ok && answer.organizations?.length ? answer.organizations : null;

  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} className="surface m-auto w-[min(440px,94vw)] rounded-control border p-0 text-[var(--text)] shadow-float">
      <div className="space-y-3 px-5 py-4">
        <h2 className="font-semibold">{action === "sign-in" ? "Sign in to Reflektor" : "Publish to Reflektor"}</h2>

        {action === "sign-in" &&
          (status?.signedIn ? (
            <p className="text-sm">
              Signed in as {who}.{" "}
              <span className="text-muted">
                {status.autoPublish ? "While a branch's pull request is open, its report goes to your organization by itself. You can turn that off in Settings." : "Publish a report from this menu."}
              </span>
            </p>
          ) : error || pending?.error ? (
            <p className="text-sm text-danger-600 dark:text-danger-400">{error ?? pending?.error}</p>
          ) : pending ? (
            <>
              <p className="text-sm text-muted">Open Reflektor, check that it shows this code, and approve:</p>
              <p className="num text-center text-2xl font-semibold tracking-widest">{pending.userCode}</p>
              <div className="flex justify-center">
                <a href={pending.verificationUriComplete} target="_blank" rel="noreferrer" className={mainButton}>
                  Open Reflektor
                  <ExternalLink aria-hidden className="size-3.5" />
                </a>
              </div>
              <Waiting>Waiting for your approval…</Waiting>
            </>
          ) : (
            <Waiting>Asking Reflektor for a code…</Waiting>
          ))}

        {action === "publish" &&
          (busy ? (
            <Waiting>Publishing…</Waiting>
          ) : error ? (
            <p className="text-sm text-danger-600 dark:text-danger-400">{error}</p>
          ) : answer?.ok ? (
            <p className="text-sm">
              Round {answer.round} is on Reflektor{answer.organization ? `, in ${answer.organization}` : ""}.
              {answer.already && <span className="text-muted"> It had been published before.</span>}
            </p>
          ) : choices ? (
            <>
              <p className="text-sm text-muted">{answer?.reason === "unknown_organization" ? answer.message : "Several of your organizations approve this repository. Publish to:"}</p>
              <div className="flex flex-wrap gap-2">
                {choices.map((o) => (
                  <button key={o.slug} type="button" onClick={() => void publish(o.slug)} className={button}>
                    {o.name} <span className="font-mono text-xs text-muted">{o.slug}</span>
                  </button>
                ))}
              </div>
            </>
          ) : answer ? (
            <p className="text-sm text-danger-600 dark:text-danger-400">{answer.message}</p>
          ) : null)}

        <div className="flex justify-end gap-2 pt-1">
          {action === "sign-in" && !status?.signedIn && (error || pending?.error) && (
            <button type="button" onClick={startSignIn} className={button}>
              Try again
            </button>
          )}
          {action === "publish" && (answer?.reason === "unauthorized" || answer?.reason === "signed_out") && (
            <button type="button" onClick={() => onAction("sign-in")} className={button}>
              Sign in again
            </button>
          )}
          {action === "publish" && answer?.ok && answer.url && (
            <a href={answer.url} target="_blank" rel="noreferrer" className={mainButton}>
              Open on Reflektor
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          )}
          <button type="button" onClick={onClose} className={button}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
};
