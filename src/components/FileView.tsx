// An image or JSON file from the reviewed folder, shown as it is.
import { useEffect, useState } from "react";
import { mediaUrl } from "../api.ts";
import { isImage } from "../format.ts";

interface Props {
  path: string;
  /** The file's modification time, so a changed file is fetched again. */
  mtime?: number;
}

export function FileView({ path, mtime }: Props) {
  const src = mediaUrl(path, mtime);
  const [text, setText] = useState<string | null>(null);
  const image = isImage(path);

  useEffect(() => {
    if (image) return;
    let current = true;
    fetch(src)
      .then((res) => res.text())
      .then((raw) => {
        if (!current) return;
        try {
          setText(JSON.stringify(JSON.parse(raw), null, 2));
        } catch {
          setText(raw);
        }
      })
      .catch(() => current && setText(null));
    return () => {
      current = false;
    };
  }, [src, image]);

  return (
    <main className="player file-view" data-testid="file-view">
      {image ? (
        <img className="file-image" src={src} alt={path.split("/").pop()} />
      ) : (
        <pre className="file-json">{text}</pre>
      )}
    </main>
  );
}
