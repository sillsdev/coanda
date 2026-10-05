// Markings drawn over a picture while its draft is made, so changing one needs no new recording.
// Each box or arrow is drawn once as a transparent PNG, then laid over the picture with ffmpeg: a
// box fades and shrinks into place as it appears and grows as it goes; an arrow slides in toward
// what it points at. A dissolve lays the frame from just before it over the picture and fades it
// away, so text that appeared at once comes in gradually.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { Marking, MarkingStyle } from "../shared/types.ts";

/** How a marking looks unless the timeline says otherwise. */
export const DEFAULT_MARKING_STYLE: Required<MarkingStyle> = {
  scale: 1,
  color: "#ffb627",
  border: 3,
  radius: 10,
  ring: 4,
  ringOpacity: 0.25,
  glow: 22,
  glowOpacity: 0.55,
  fade: 0.35,
  grow: 0.06,
  arrowLength: 64,
  arrowWidth: 40,
  arrowGap: 8,
  arrowSlide: 34,
};

/** The least seconds a box or arrow stays up. */
export const MIN_BOX_SECONDS = 2;
/** Boxes and arrows on screen together whose ends are this close leave together. */
export const LEAVE_TOGETHER = 0.5;

/**
 * Boxes and arrows as reviewers want them: each up at least `minSeconds`, and those on screen
 * together that end within `together` seconds of each other all ending at the latest of those
 * ends. Dissolves are left alone.
 */
export function settleBoxes(
  markings: Marking[],
  minSeconds = MIN_BOX_SECONDS,
  together = LEAVE_TOGETHER,
): Marking[] {
  const out = markings.map((m) =>
    m.kind === "dissolve" ? m : { ...m, to: Math.max(m.to, round(m.from + minSeconds)) },
  );
  const shown = out
    .filter((m) => m.kind !== "dissolve")
    .sort((a, b) => a.to - b.to || a.from - b.from);
  let group: Marking[] = [];
  const close = () => {
    const end = Math.max(...group.map((m) => m.to));
    for (const m of group) m.to = end;
    group = [];
  };
  for (const m of shown) {
    if (group.length && (m.to - group[0].to > together || !group.some((g) => m.from < g.to))) {
      close();
    }
    group.push(m);
  }
  if (group.length) close();
  return out;
}

export function markingStyle(
  timelineStyle: MarkingStyle | undefined,
  marking: Marking,
): Required<MarkingStyle> {
  return { ...DEFAULT_MARKING_STYLE, ...timelineStyle, ...marking.style };
}

/** A box as a PNG, with room around it for its ring and glow. `margin` is how far the image
 * reaches past the box on each side, in picture pixels. */
export function boxImage(
  marking: Marking,
  style: Required<MarkingStyle>,
): { png: Buffer; width: number; height: number; margin: number } {
  const s = style.scale;
  const border = style.border * s;
  const radius = Math.min(style.radius * s, marking.width / 2, marking.height / 2);
  const ring = style.ring * s;
  const sigma = (style.glow * s) / 2;
  const margin = Math.ceil(Math.max(ring, sigma * 3)) + 2;
  const width = Math.round(marking.width) + 2 * margin;
  const height = Math.round(marking.height) + 2 * margin;
  const [r, g, b] = hexColor(style.color);
  const hw = marking.width / 2;
  const hh = marking.height / 2;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      // Distance from the box's outer edge: negative inside, positive outside.
      const d = roundedBoxDistance(x + 0.5 - margin - hw, y + 0.5 - margin - hh, hw, hh, radius);
      let alpha: number;
      if (d <= 0) {
        alpha = clamp(d + border + 0.5);
      } else {
        const ringAlpha = style.ringOpacity * clamp(ring - d + 0.5);
        const glowAlpha = sigma > 0 ? style.glowOpacity * 0.5 * erfc(d / (sigma * Math.SQRT2)) : 0;
        alpha = ringAlpha + glowAlpha * (1 - ringAlpha);
        // The border's own anti-aliased outer edge.
        alpha = Math.max(alpha, clamp(0.5 - d));
      }
      const at = row + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = Math.round(alpha * 255);
    }
  }
  return { png: encodePng(width, height, raw), width, height, margin };
}

/** Which way an arrow on each side of a box points. */
const POINTING = {
  left: { dx: 1, dy: 0 },
  right: { dx: -1, dy: 0 },
  above: { dx: 0, dy: 1 },
  below: { dx: 0, dy: -1 },
} as const;

/** An arrow as a PNG, pointing at a box from its `side`, with room around it for its glow.
 * `tipX`, `tipY` is where its tip is in the image, in picture pixels. */
export function arrowImage(
  side: NonNullable<Marking["side"]>,
  style: Required<MarkingStyle>,
): { png: Buffer; width: number; height: number; tipX: number; tipY: number } {
  const s = style.scale;
  const length = style.arrowLength * s;
  const head = style.arrowWidth * s;
  const shaft = head * 0.4;
  const headLength = Math.min(length * 0.42, head * 0.9);
  const sigma = (style.glow * s) / 2;
  const margin = Math.ceil(sigma * 3) + 2;
  const { dx, dy } = POINTING[side];
  const across = Math.ceil(head) + 2 * margin;
  const along = Math.ceil(length) + 2 * margin;
  const width = dx ? along : across;
  const height = dx ? across : along;
  // The arrow pointing along +u, its tail at u = 0 and its tip at u = length, across v = 0.
  const polygon: [number, number][] = [
    [0, -shaft / 2],
    [length - headLength, -shaft / 2],
    [length - headLength, -head / 2],
    [length, 0],
    [length - headLength, head / 2],
    [length - headLength, shaft / 2],
    [0, shaft / 2],
  ];
  const middle = margin + head / 2;
  const local = (x: number, y: number): [number, number] =>
    dx > 0
      ? [x - margin, y - middle]
      : dx < 0
        ? [margin + length - x, y - middle]
        : dy > 0
          ? [y - margin, x - middle]
          : [margin + length - y, x - middle];
  const [r, g, b] = hexColor(style.color);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const d = polygonDistance(...local(x + 0.5, y + 0.5), polygon);
      const glow =
        sigma > 0 ? style.glowOpacity * 0.5 * erfc(Math.max(d, 0) / (sigma * Math.SQRT2)) : 0;
      const alpha = Math.max(clamp(0.5 - d), d > 0 ? glow : 0);
      const at = row + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = Math.round(alpha * 255);
    }
  }
  const tipX = dx > 0 ? margin + length : dx < 0 ? margin : middle;
  const tipY = dy > 0 ? margin + length : dy < 0 ? margin : middle;
  return { png: encodePng(width, height, raw), width, height, tipX, tipY };
}

/** Where an arrow's image goes over the picture (its top left, before it slides), and which
 * way it slides in. */
export function arrowPlace(
  m: Marking,
  style: Required<MarkingStyle>,
  image: { tipX: number; tipY: number },
): { x: number; y: number; dx: number; dy: number } {
  const side = m.side ?? "left";
  const gap = style.arrowGap * style.scale;
  const cx = m.x + m.width / 2;
  const cy = m.y + m.height / 2;
  const tip =
    side === "left"
      ? [m.x - gap, cy]
      : side === "right"
        ? [m.x + m.width + gap, cy]
        : side === "above"
          ? [cx, m.y - gap]
          : [cx, m.y + m.height + gap];
  const { dx, dy } = POINTING[side];
  return { x: Math.round(tip[0] - image.tipX), y: Math.round(tip[1] - image.tipY), dx, dy };
}

/** The time in the picture of the frame just before `t`, at `fps`, a little early so that a
 * seek to it lands on that frame. */
export function frameBefore(t: number, fps = 30): number {
  const k = Math.ceil(t * fps - 1e-6) - 1;
  return Math.max(0, round(k / fps - 0.004));
}

/**
 * The ffmpeg inputs and filters that lay the markings over the stream `input`, giving `output`.
 * `firstInput` is the index the first marking's input will have among ffmpeg's inputs; each
 * marking adds one input. A dissolve's input is `picture`, the file `input` comes from, so a
 * timeline with dissolves needs it. Dissolves go on first, so a box or arrow is never
 * dissolved away.
 */
export function markingFilters(opts: {
  markings: Marking[];
  style: MarkingStyle | undefined;
  dir: string;
  name: string;
  input: string;
  output: string;
  firstInput: number;
  picture?: string;
}): { inputs: string[]; filters: string[] } {
  const inputs: string[] = [];
  const filters: string[] = [];
  let current = opts.input;
  const order = opts.markings
    .map((m, k) => ({ m, k }))
    .sort((a, b) => Number(b.m.kind === "dissolve") - Number(a.m.kind === "dissolve"));
  order.forEach(({ m, k }, n) => {
    const style = markingStyle(opts.style, m);
    const input = opts.firstInput + inputs.filter((a) => a === "-i").length;
    const out = n === order.length - 1 ? opts.output : `[mk${k}]`;
    const fade = style.fade;
    const shown = Math.max(m.to - m.from, 0) + fade;
    const fades =
      fade > 0
        ? `,fade=t=in:st=0:d=${fade}:alpha=1,fade=t=out:st=${(shown - fade).toFixed(3)}:d=${fade}:alpha=1`
        : "";
    const loop = (file: string) =>
      inputs.push("-loop", "1", "-framerate", "30", "-t", shown.toFixed(3), "-i", file);
    const file = join(opts.dir, `${opts.name}.marking-${k}.png`);

    if (m.kind === "dissolve") {
      if (!opts.picture) throw new Error(`The dissolve ${m.key} needs the picture as an input`);
      const seconds = Math.max(m.to - m.from, 1 / 30);
      inputs.push("-ss", frameBefore(m.from).toFixed(3), "-t", "1", "-i", opts.picture);
      const [x, y, w, h] = [m.x, m.y, m.width, m.height].map((v) => Math.max(0, Math.round(v)));
      filters.push(
        `[${input}:v]trim=end_frame=1,setpts=PTS-STARTPTS,` +
          `crop=w='min(${w},iw)':h='min(${h},ih)':x='min(${x},iw-ow)':y='min(${y},ih-oh)',` +
          `format=rgba,tpad=stop_mode=clone:stop_duration=${seconds.toFixed(3)},` +
          `fade=t=out:st=0:d=${seconds.toFixed(3)}:alpha=1,setpts=PTS-STARTPTS+${m.from}/TB[ds${k}]`,
        `${current}[ds${k}]overlay=x='min(${x},W-w)':y='min(${y},H-h)':eof_action=pass${out}`,
      );
    } else if (m.kind === "arrow") {
      const image = arrowImage(m.side ?? "left", style);
      writeFileSync(file, image.png);
      loop(file);
      const at = arrowPlace(m, style, image);
      // How far it still has to slide: the full distance at `from`, easing out to none.
      const left = fade > 0 ? `pow(1-clip((t-${m.from})/${fade},0,1),2)` : "0";
      const slide = style.arrowSlide * style.scale;
      const along = (base: number, d: number) =>
        d ? `${base}${d > 0 ? "-" : "+"}${slide.toFixed(1)}*${left}` : `${base}`;
      filters.push(
        `[${input}:v]format=rgba${fades},setpts=PTS-STARTPTS+${m.from}/TB[ar${k}]`,
        `${current}[ar${k}]overlay=x='${along(at.x, at.dx)}':y='${along(at.y, at.dy)}'` +
          `:eof_action=pass:eval=frame${out}`,
      );
    } else {
      const image = boxImage(m, style);
      writeFileSync(file, image.png);
      loop(file);
      // 1 at the start and end of the fade, 0 once the box has settled.
      const away = fade > 0 ? `max(0,max(1-t/${fade},1-(${shown.toFixed(3)}-t)/${fade}))` : "0";
      const size = `(1+${style.grow}*${away})`;
      const cx = m.x + m.width / 2;
      const cy = m.y + m.height / 2;
      filters.push(
        `[${input}:v]format=rgba${fades}` +
          `,scale=w='trunc(iw*${size}/2)*2':h='trunc(ih*${size}/2)*2':eval=frame` +
          `,setpts=PTS-STARTPTS+${m.from}/TB[box${k}]`,
        `${current}[box${k}]overlay=x='${cx}-w/2':y='${cy}-h/2':eof_action=pass:eval=frame${out}`,
      );
    }
    current = out;
  });
  return { inputs, filters };
}

/** Signed distance from a point to a polygon: negative inside, positive outside. */
function polygonDistance(px: number, py: number, polygon: [number, number][]): number {
  let nearest = Infinity;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[j];
    const [bx, by] = polygon[i];
    const ex = bx - ax;
    const ey = by - ay;
    const along = clamp(((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey));
    nearest = Math.min(nearest, Math.hypot(px - ax - ex * along, py - ay - ey * along));
    if (ay > py !== by > py && px < ax + ((py - ay) * ex) / ey) inside = !inside;
  }
  return inside ? -nearest : nearest;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Signed distance from a point to a rounded rectangle centred on the origin. */
function roundedBoxDistance(px: number, py: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function clamp(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** The complementary error function, to within about 1e-7. */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

function hexColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a colour like #ffb627: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** An 8-bit RGBA PNG from rows that each start with filter byte 0. */
function encodePng(width: number, height: number, raw: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
