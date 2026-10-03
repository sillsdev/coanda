// Thumbnails of the images pasted into notes and replies.
import { mediaUrl } from "../api.ts";

/**
 * Thumbnails of images. Saved ones are paths relative to the reviewed folder and open in the
 * default app when clicked; pasted ones are data URLs. With `onRemove`, each has a remove button.
 */
export function Thumbs({
  saved = [],
  pasted = [],
  onOpen,
  onRemove,
}: {
  saved?: string[];
  pasted?: string[];
  onOpen?: (path: string) => void;
  onRemove?: (image: string) => void;
}) {
  if (!saved.length && !pasted.length) return null;
  return (
    <div className="thumbs" onClick={(e) => e.stopPropagation()}>
      {[
        ...saved.map((p) => ({ key: p, src: mediaUrl(p), path: p })),
        ...pasted.map((u) => ({ key: u, src: u, path: null })),
      ].map((img) => (
        <span key={img.key} className="thumb">
          <img
            src={img.src}
            alt=""
            onClick={() => img.path && onOpen?.(img.path)}
            className={img.path && onOpen ? "openable" : undefined}
          />
          {onRemove && (
            <button className="thumb-remove" title="Remove" onClick={() => onRemove(img.key)}>
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
