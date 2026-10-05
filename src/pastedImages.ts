// Images pasted into a note or reply, kept as data URLs until the note is saved.
import { useCallback, useState, type ClipboardEvent } from "react";

/** The images on the clipboard of a paste event, read as data URLs. */
function readPasted(e: ClipboardEvent): Promise<string[]> {
  const files = Array.from(e.clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
  return Promise.all(
    files.map(
      (f) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error ?? new Error("Could not read the image"));
          reader.readAsDataURL(f);
        }),
    ),
  );
}

/** Images pasted into a text box, as data URLs, until they're saved. */
export function usePastedImages() {
  const [images, setImages] = useState<string[]>([]);
  const clear = useCallback(() => setImages([]), []);
  return {
    images,
    /** For a text box's onPaste: takes any images, and leaves text to paste as usual. */
    onPaste: (e: ClipboardEvent) => {
      if (!Array.from(e.clipboardData.items).some((i) => i.type.startsWith("image/"))) return;
      e.preventDefault();
      void readPasted(e).then((urls) => setImages((list) => [...list, ...urls]));
    },
    remove: (url: string) => setImages((list) => list.filter((u) => u !== url)),
    clear,
  };
}
