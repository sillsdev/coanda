import { useState } from "react";
import { ChevronIcon, FolderIcon } from "./icons.tsx";

interface Props {
  rootName: string;
  /** Null until a folder has been chosen. */
  rootPath: string | null;
  recent: string[];
  /** Opens the OS folder chooser and switches to the chosen folder. */
  onBrowse: () => Promise<void>;
  /** Switches to a folder from the recent list. */
  onChoose: (path: string) => Promise<void>;
}

/** The Folder section at the top of the sidebar: shows the folder and lets you switch it. */
export function FolderPicker({ rootName, rootPath, recent, onBrowse, onChoose }: Props) {
  const [showRecent, setShowRecent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const others = recent.filter((r) => r !== rootPath);

  const act = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      setShowRecent(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sidebar-head" data-testid="folder">
      <div className="folder-top">
        <div className="eyebrow">Folder</div>
        {rootPath && (
          <button className="link-btn small-btn" onClick={() => void act(onBrowse)} disabled={busy}>
            {busy ? "Choosing…" : "Change…"}
          </button>
        )}
      </div>
      {rootPath ? (
        <>
          <div className="mono sidebar-root">{rootName}</div>
          <div className="sidebar-path" title={rootPath}>
            {rootPath}
          </div>
        </>
      ) : (
        <button
          className="btn btn-primary choose-btn"
          onClick={() => void act(onBrowse)}
          disabled={busy}
        >
          <FolderIcon />
          {busy ? "Choosing…" : "Choose a folder…"}
        </button>
      )}
      {error && <div className="folder-error">{error}</div>}
      {others.length > 0 && (
        <div className="recent">
          <button
            className="recent-toggle"
            aria-expanded={showRecent}
            onClick={() => setShowRecent((s) => !s)}
          >
            <ChevronIcon size={12} open={showRecent} />
            Recent
          </button>
          {showRecent &&
            others.map((r) => (
              <button
                key={r}
                className="recent-row"
                title={r}
                onClick={() => void act(() => onChoose(r))}
              >
                <FolderIcon className="tree-icon muted" />
                <span className="recent-path">{r}</span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
