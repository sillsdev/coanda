import { useState } from "react";
import { KeyIcon } from "./icons.tsx";

interface Props {
  elevenLabsKeySaved: boolean;
  onSaveKey: (key: string) => Promise<void>;
}

/** The key button in the header, with a box for pasting the ElevenLabs API key. */
export function Settings({ elevenLabsKeySaved, onSaveKey }: Props) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");

  const save = async () => {
    if (!key.trim()) return;
    await onSaveKey(key.trim());
    setKey("");
    setOpen(false);
  };

  return (
    <div className="settings">
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
          <label className="eyebrow" htmlFor="eleven-key">
            ElevenLabs API key
          </label>
          <input
            id="eleven-key"
            className="field mono-field"
            type="password"
            autoComplete="off"
            placeholder={elevenLabsKeySaved ? "Saved" : ""}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <button
            className="btn btn-primary push-right"
            onClick={() => void save()}
            disabled={!key.trim()}
          >
            Save
          </button>
        </div>
      )}
    </div>
  );
}
