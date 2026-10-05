import { useEffect, useRef, useState } from "react";
import { api, type KeyStart, type SavedKeys } from "../api.ts";
import { FolderIcon, KeyIcon, PasteIcon } from "./icons.tsx";

interface Props {
  saved: SavedKeys;
  onSaveKey: (which: keyof SavedKeys, key: string) => Promise<void>;
  /** The folder of the selected project's app, when a project is selected; its path is null
   * when none is chosen. */
  app?: { path: string | null; onChoose: () => void };
}

const KEYS: { which: keyof SavedKeys; label: string }[] = [
  { which: "elevenLabsKey", label: "ElevenLabs API key for voice" },
  { which: "openRouterKey", label: "OpenRouter API key for image generation / localization" },
];

/** The key button in the header, with a place for each API key Claude's tools use. */
export function Settings({ saved, onSaveKey, app }: Props) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  /** What's left on the OpenRouter account, fetched each time the box opens. */
  const [credit, setCredit] = useState<number | null>(null);
  useEffect(() => {
    if (!open || !saved.openRouterKey) return;
    let live = true;
    api.openRouterCredits().then(
      (c) => live && setCredit(c.remaining),
      () => live && setCredit(null),
    );
    return () => {
      live = false;
    };
  }, [open, saved.openRouterKey]);

  // A press anywhere outside closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div className="settings" ref={boxRef}>
      <button
        className="icon-btn"
        aria-label="Settings"
        title="Settings"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <KeyIcon />
      </button>
      {open && (
        <div className="settings-pop" data-testid="settings">
          {app && (
            <section className="settings-section" data-testid="app-setting">
              <h3 className="settings-title">App</h3>
              <p className="settings-lead">
                The program this project's videos show. Claude runs it from the folder you choose
                here, and records it.
              </p>
              <button className="app-picker" onClick={app.onChoose}>
                <FolderIcon className="app-picker-icon" size={16} />
                <span
                  className={`app-picker-path mono${app.path ? "" : " empty"}`}
                  title={app.path ?? ""}
                >
                  {app.path ?? "Choose a folder"}
                </span>
                <span className="app-picker-action">{app.path ? "Change…" : "Choose…"}</span>
              </button>
              <dl className="settings-facts">
                <dt>What to choose</dt>
                <dd>
                  The folder you run the app from: a source checkout, such as a clone of
                  BloomDesktop, or an installed copy. Not this video project's folder.
                </dd>
                <dt>Without it</dt>
                <dd>Claude can help plan the video, but can't run the app or record it.</dd>
                <dt>What Claude reads</dt>
                <dd>
                  The folder's <code>AGENTS.md</code> and <code>CLAUDE.md</code>, for how to build,
                  start and drive the app, and its skills in <code>.claude/skills</code>. The more
                  these say, the less Claude has to work out for itself.
                </dd>
                <dt>A source checkout</dt>
                <dd>
                  Claude may also fix the app's skills when they turn out to be wrong, or pass the
                  fix to a Claude session already working in that folder. Changes are left
                  uncommitted for you to review. An installed copy is only run.
                </dd>
                <dt>Where it's saved</dt>
                <dd>
                  On this computer, for this project. It isn't in the project's files, so each
                  person working on the project sets their own.
                </dd>
                <dt>Changing it</dt>
                <dd>
                  Takes effect once Claude finishes what it's doing. The conversation carries on.
                </dd>
              </dl>
            </section>
          )}
          <section className="settings-section">
            <h3 className="settings-title">API keys</h3>
            {KEYS.map(({ which, label }) => (
              <KeyField
                key={which}
                label={label}
                saved={saved[which]}
                onSave={(key) => onSaveKey(which, key)}
                note={
                  which === "openRouterKey" && credit !== null ? `$${credit.toFixed(2)} left` : null
                }
              />
            ))}
          </section>
          <button className="btn btn-ghost-outline push-right" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}

/** A saved key shown as its first characters with a bullet for each one after, and a button
 * that replaces it with the key on the clipboard. */
function KeyField(props: {
  label: string;
  saved: KeyStart | null;
  onSave: (key: string) => Promise<void>;
  /** A short fact about the account, such as its credit. */
  note?: string | null;
}) {
  const masked = props.saved
    ? props.saved.start + "•".repeat(Math.max(0, props.saved.length - props.saved.start.length))
    : "";
  const paste = async () => {
    const key = (await navigator.clipboard.readText()).trim();
    if (key) await props.onSave(key);
  };
  return (
    <div className="key-field">
      <div className="key-head">
        <span className="eyebrow">{props.label}</span>
        <button
          className="mini-btn push-right"
          title="Paste key"
          aria-label={`Paste ${props.label}`}
          onClick={() => void paste()}
        >
          <PasteIcon />
        </button>
      </div>
      {masked && (
        <div className="key-masked mono" data-testid="key-masked">
          {masked}
        </div>
      )}
      {props.note && <div className="key-note">{props.note}</div>}
    </div>
  );
}
