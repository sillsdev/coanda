import { useEffect, useRef, useState } from "react";
import { api, type KeyStart, type SavedKeys } from "../api.ts";
import { KeyIcon, PasteIcon } from "./icons.tsx";

interface Props {
  saved: SavedKeys;
  onSaveKey: (which: keyof SavedKeys, key: string) => Promise<void>;
}

const KEYS: { which: keyof SavedKeys; label: string }[] = [
  { which: "elevenLabsKey", label: "ElevenLabs API key for voice" },
  { which: "openRouterKey", label: "OpenRouter API key for image generation / localization" },
];

/** The key button in the header, with a place for each API key Claude's tools use. */
export function Settings({ saved, onSaveKey }: Props) {
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
        aria-label="Keys"
        title="Keys"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <KeyIcon />
      </button>
      {open && (
        <div className="settings-pop" data-testid="settings">
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
