import { useState } from "react";

interface Props {
  /** Distance of the handle from the left edge (for a left sidebar) or right edge. */
  offset: number;
  /** The sidebar's current width. */
  width: number;
  side: "left" | "right";
  /** Called with the new width while dragging. */
  onResize: (width: number) => void;
}

/** A thin handle on a sidebar's inner edge that resizes it when dragged. */
export function Splitter({ offset, width, side, onResize }: Props) {
  const [start, setStart] = useState<{ x: number; width: number } | null>(null);

  return (
    <div
      className={`splitter${start ? " dragging" : ""}`}

      style={side === "left" ? { left: offset - 3 } : { right: offset - 3 }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setStart({ x: e.clientX, width });
      }}
      onPointerMove={(e) => {
        if (!start) return;
        const dx = e.clientX - start.x;
        onResize(side === "left" ? start.width + dx : start.width - dx);
      }}
      onPointerUp={() => setStart(null)}
      onPointerCancel={() => setStart(null)}
    />
  );
}
