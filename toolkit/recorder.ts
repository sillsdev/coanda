// Records an app that Chromium draws (a web page, Electron, WebView2) for a video: lays it out
// as a small screen rendered sharp, captures frames, draws a pointer and click ripples into the
// page, paces narration lines, and logs every line, action, highlight box, arrow and dissolve to
// events.json, with where the pointer went, each press and each keystroke. Boxes, arrows and
// dissolves are not drawn into the frames: `coanda subtitles` and `coanda voice` draw them from
// the picture's timeline, so one can change without a new recording.
//
// Its pacing follows what reviewers asked for: a move with no duration given takes 400 ms plus
// 0.7 ms per pixel, at most 1.1 s; a press's element gets the click `clickBeat` seconds after the
// ripple, so the app never reacts the instant the ripple shows; typing starts at least `typeBeat`
// seconds after the pointer last moved or pressed; and a box stays up at least `minBoxSeconds`.
//
// A project's shot list imports this and hands it a Playwright page it has already reached:
// how to launch and reach the app is the project's business.
//
// The app is laid out as a `width` x `height` screen and rendered at device scale `scale`, so a
// 1024x768 layout gives sharp 1536x1152 frames. Frames are CDP screenshots with three requests
// in flight, about 25 fps; more in flight starves the scripted mouse. A CDP screencast would
// ignore the device scale, and zooming the page with CSS instead can break layouts that measure
// text.
//
// While screenshots are being taken, Chromium reads a mouse move at its position divided by the
// device scale, so moves are sent multiplied by the scale while capturing. Some apps also stop
// taking real clicks and wheel input once screenshots start (Bloom did), so clicks go to the
// element itself, scrolling is by script, and drags are synthetic mouse events. Real mouse
// moves still arrive, so hover styling is real.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Frame, Locator, Page } from "@playwright/test";
import type { Marking, PointerSample } from "../shared/types.ts";

/** How long a word takes to say, for pacing shots before there is a voice. */
export const SECONDS_PER_WORD = 0.43;

export const estimateSpeech = (text: string, perWord = SECONDS_PER_WORD) =>
  0.4 + perWord * text.split(/\s+/).filter(Boolean).length;

/** How long a pointer move of `distance` layout pixels takes when the shot doesn't say. */
export const glideMs = (distance: number) => Math.round(Math.min(1100, 400 + 0.7 * distance));

/** The pause after each character typed, as a share of the usual: uneven, like a person's,
 * but the same each time the same text is typed, so a repeated take repeats. */
export function typingRhythm(text: string): number[] {
  let seed = 2166136261;
  const rhythm: number[] = [];
  for (const ch of text) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  for (const _ of text) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    rhythm.push(0.6 + (seed / 2 ** 32) * 0.8);
  }
  return rhythm;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What `finish()` writes to events.json. Times are seconds from the start of capture. */
export interface TakeEvents {
  /** When capture started, in seconds since the epoch, as frames.json's times are. */
  start: number;
  /** Picture pixels per layout pixel. */
  scale: number;
  events: ({ t: number; say: string } | { t: number; what: string })[];
  /** Highlight boxes, arrows and dissolves, in picture pixels and take seconds. */
  markings: Marking[];
  /** Where the drawn pointer was as it moved, in picture pixels and take seconds. */
  pointer?: PointerSample[];
  /** Each press (a click, a click into text, the start of a drag), where the pointer was. */
  presses?: PointerSample[];
  /** When each key was typed. */
  keys?: number[];
  /** The seconds per word say() paced lines with. */
  secondsPerWord?: number;
}

export interface RecorderOptions {
  page: Page;
  /** Where the take goes; emptied first. Frames go in its `frames` folder. */
  takeDir: string;
  /** The screen the app is laid out on, in layout pixels. */
  width?: number;
  height?: number;
  /** Picture pixels per layout pixel. */
  scale?: number;
  secondsPerWord?: number;
  /** Seconds from a press's ripple to the click reaching the element. Default 0.3. */
  clickBeat?: number;
  /** The least seconds between the pointer's last move or press and the first key typed.
   * Default 0.6. */
  typeBeat?: number;
  /** The least seconds a box or arrow stays up: unhighlight() waits until then. Default 2. */
  minBoxSeconds?: number;
  /** Runs once the recorder's overlays are in the page: the project's own per-page setup, such
   * as hiding an API key that no frame may show. */
  setup?: (page: Page) => Promise<void>;
}

export async function startRecorder(opts: RecorderOptions) {
  const { page, takeDir } = opts;
  const width = opts.width ?? 1024;
  const height = opts.height ?? 768;
  const scale = opts.scale ?? 1.5;
  const perWord = opts.secondsPerWord ?? SECONDS_PER_WORD;
  const clickBeat = opts.clickBeat ?? 0.3;
  const typeBeat = opts.typeBeat ?? 0.6;
  const minBoxSeconds = opts.minBoxSeconds ?? 2;
  rmSync(takeDir, { recursive: true, force: true });
  mkdirSync(join(takeDir, "frames"), { recursive: true });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  });
  await page.waitForTimeout(1500);
  await page.mouse.move(width - 10, height - 10);
  await installOverlays(page);
  await opts.setup?.(page);

  const frames: { file: string; t: number }[] = [];
  let frameNumber = 0;
  let capturing = false;
  let capturers: Promise<void>[] = [];
  const events: TakeEvents["events"] = [];
  const markings: Marking[] = [];
  /** Boxes and arrows on screen, by their keys. */
  const openBoxes = new Map<string, Omit<Marking, "to">>();
  const pointer: PointerSample[] = [];
  const presses: PointerSample[] = [];
  const keys: number[] = [];
  /** When the pointer last moved or pressed, in take seconds. */
  let pointerActed = -Infinity;
  let start = 0;
  const now = () => Date.now() / 1000 - start;
  const stamp = () => Number(now().toFixed(3));
  const toPicture = (b: Box): Box => ({
    x: Math.round(b.x * scale),
    y: Math.round(b.y * scale),
    width: Math.round(b.width * scale),
    height: Math.round(b.height * scale),
  });

  const r = {
    page,
    takeDir,
    frame: (name: string) => page.frame({ name }),
    now,
    /** Logs an action, which becomes an anchor in the picture's timeline. */
    log(what: string) {
      events.push({ t: stamp(), what });
      console.log(`${now().toFixed(2)}  ${what}`);
    },
    async at(t: number) {
      const wait = (t - now()) * 1000;
      if (wait > 0) await page.waitForTimeout(wait);
    },
    wait: (seconds: number) => page.waitForTimeout(seconds * 1000),

    startCapture() {
      start = Date.now() / 1000;
      capturing = true;
      capturers = Array.from({ length: 3 }, async () => {
        while (capturing) {
          const { data } = await cdp.send("Page.captureScreenshot", {
            format: "jpeg",
            quality: 90,
            optimizeForSpeed: true,
          });
          const t = Date.now() / 1000;
          const file = `f${String(frameNumber++).padStart(5, "0")}.jpg`;
          writeFileSync(join(takeDir, "frames", file), Buffer.from(data, "base64"));
          frames.push({ file, t });
        }
      });
    },
    /** Stops capturing and writes frames.json and events.json. The caller closes the app. */
    async finish() {
      capturing = false;
      await Promise.all(capturers);
      frames.sort((a, b) => a.t - b.t);
      writeFileSync(join(takeDir, "frames.json"), JSON.stringify(frames));
      closeBoxes([...openBoxes.keys()]);
      markings.sort((a, b) => a.from - b.from);
      const log: TakeEvents = {
        start,
        scale,
        events,
        markings,
        pointer,
        presses,
        keys,
        secondsPerWord: perWord,
      };
      writeFileSync(join(takeDir, "events.json"), JSON.stringify(log, null, 1));
      await page.evaluate(() =>
        document.querySelectorAll("#video-cursor, .video-ripple").forEach((e) => e.remove()),
      );
      await cdp.send("Emulation.clearDeviceMetricsOverride");
      console.log(`${frames.length} frames in ${takeDir}`);
    },

    // Narration. say() starts a line once the one before would have been spoken.
    speechEnds: 0,
    async say(text: string) {
      await r.quiet();
      events.push({ t: stamp(), say: text });
      console.log(`${now().toFixed(2)}  SAY ${text}`);
      r.speechEnds = now() + estimateSpeech(text, perWord);
    },
    /** Waits until the current line would have been spoken, and `extra` seconds more. */
    async quiet(extra = 0.35) {
      await r.at(r.speechEnds + extra);
    },

    // The drawn pointer.
    cursorX: width + 16,
    cursorY: height + 32,
    showCursor: (on = true) =>
      page.evaluate((v) => (window as unknown as VideoWindow).__video.show(v), on),
    /** Glides the pointer to (x, y), in layout pixels, over `ms`, or `glideMs` of the distance. */
    async moveTo(x: number, y: number, ms?: number) {
      const fromX = r.cursorX;
      const fromY = r.cursorY;
      ms ??= glideMs(Math.hypot(x - fromX, y - fromY));
      sample(fromX, fromY);
      const steps = Math.max(8, Math.round(ms / 16));
      const t0 = Date.now();
      for (let i = 1; i <= steps; i++) {
        const p = ease(i / steps);
        const px = fromX + (x - fromX) * p;
        const py = fromY + (y - fromY) * p;
        const k = capturing ? scale : 1;
        await page.mouse.move(px * k, py * k);
        await page.evaluate(
          ([a, b]) => (window as unknown as VideoWindow).__video.place(a, b),
          [px, py],
        );
        sample(px, py);
        const due = t0 + (ms * i) / steps;
        if (Date.now() < due) await page.waitForTimeout(due - Date.now());
      }
      r.cursorX = x;
      r.cursorY = y;
      pointerActed = now();
    },
    /** Moves the pointer onto an element, at a fraction (fx, fy) of its box. */
    async moveToElement(locator: Locator, ms?: number, fx = 0.5, fy = 0.5) {
      const b = await locator.boundingBox();
      if (!b) throw new Error(`Cannot move to ${String(locator)}: it is not on screen.`);
      await r.moveTo(b.x + b.width * fx, b.y + b.height * fy, ms);
    },
    /** Shows a ripple where the pointer is and logs it as a press, without clicking anything:
     * for a press the shot carries out some other way, such as focusing a box by script. */
    async ripple() {
      presses.push(pointerSample(r.cursorX, r.cursorY));
      pointerActed = now();
      await page.evaluate(
        ([a, b]) => (window as unknown as VideoWindow).__video.ripple(a, b),
        [r.cursorX, r.cursorY],
      );
    },
    /** Shows a ripple where the pointer is, then, `clickBeat` later, clicks the element itself. */
    async click(locator: Locator) {
      await r.ripple();
      await r.wait(clickBeat);
      await locator.evaluate((element) => (element as HTMLElement).click());
    },
    async moveAndClick(locator: Locator, ms?: number, fx = 0.5, fy = 0.5) {
      await r.moveToElement(locator, ms, fx, fy);
      await r.wait(0.25);
      await r.click(locator);
    },
    /** Puts the caret at the end of an editable element, as clicking there would. */
    async clickIntoText(locator: Locator) {
      await r.ripple();
      await r.wait(clickBeat);
      await locator.evaluate((element) => {
        (element as HTMLElement).focus();
        const range = element.ownerDocument.createRange();
        const lastParagraph = element.querySelector("p:last-of-type") ?? element;
        range.selectNodeContents(lastParagraph);
        range.collapse(false);
        const selection = element.ownerDocument.defaultView!.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
    },
    /** Types like a person, starting at least `typeBeat` after the pointer last moved or
     * pressed. */
    async type(text: string, msPerChar = 75) {
      await r.at(pointerActed + typeBeat);
      const rhythm = typingRhythm(text);
      let i = 0;
      for (const ch of text) {
        keys.push(stamp());
        if (/[a-zA-Z0-9 .,]/.test(ch)) await page.keyboard.type(ch);
        else await page.keyboard.insertText(ch);
        await page.waitForTimeout(msPerChar * rhythm[i++]);
      }
    },
    /** Presses a key, such as "Enter", logging it as typed. */
    async key(name: string) {
      keys.push(stamp());
      await page.keyboard.press(name);
    },

    // Highlight boxes, logged as markings in picture pixels and take seconds.
    /** Starts a box at `box`, in layout pixels: the outside of a 3 px border placed there by
     * the page's own styles. */
    async highlight(id: string, box: Box) {
      if (openBoxes.has(`box: ${id}`)) await r.unhighlight(id);
      const outer = await page.evaluate(
        (b) => (window as unknown as VideoWindow).__video.outerBox(b),
        box,
      );
      const key = `box: ${id}`;
      openBoxes.set(key, { key, kind: "box", ...toPicture(outer), from: stamp() });
      console.log(`${now().toFixed(2)}  BOX ${id}`);
    },
    /** Ends the box and the arrow called `id`, or, with no id, every box and arrow on screen,
     * together. First waits until each has been up `minBoxSeconds`. */
    async unhighlight(id?: string) {
      const ending = [...openBoxes.keys()].filter(
        (key) => id === undefined || key === `box: ${id}` || key === `arrow: ${id}`,
      );
      if (!ending.length) return;
      await r.at(Math.max(...ending.map((key) => openBoxes.get(key)!.from)) + minBoxSeconds);
      closeBoxes(ending);
    },
    async highlightElements(id: string, locators: Locator | Locator[], padding = 6) {
      await r.highlight(id, pad(await union(asList(locators)), padding));
    },
    /**
     * Starts an arrow on `side` of `target` (a box in layout pixels, or elements), pointing at it,
     * to draw the eye to another part of the screen. unhighlight(id) ends it, with the box of the
     * same id if there is one.
     */
    async arrow(
      id: string,
      target: Box | Locator | Locator[],
      side: NonNullable<Marking["side"]> = "left",
      padding = 6,
    ) {
      if (openBoxes.has(`arrow: ${id}`)) await r.unhighlight(id);
      const box = isBox(target) ? target : pad(await union(asList(target)), padding);
      const key = `arrow: ${id}`;
      openBoxes.set(key, { key, kind: "arrow", side, ...toPicture(box), from: stamp() });
      console.log(`${now().toFixed(2)}  ARROW ${id}`);
    },
    /**
     * Runs `action`, which makes something appear at once (a paste), so that it dissolves in: the
     * frame from just before the action fades away over `seconds`, or until the action is done
     * if that is later. `region` (a box in layout pixels, or an element) limits the dissolve to
     * that part of the screen, so a pointer moving elsewhere leaves no ghost.
     */
    async dissolve(
      action: () => Promise<unknown>,
      opts: { seconds?: number; region?: Box | Locator; key?: string } = {},
    ) {
      const region = opts.region ?? { x: 0, y: 0, width, height };
      const area = isBox(region) ? region : await union([region]);
      const from = stamp();
      await action();
      // An app can report new content before it's painted, so the fade lasts until the region
      // has stopped changing; otherwise it ends on an empty space and the content pops in.
      await stillIn(area);
      const to = Math.max(from + (opts.seconds ?? 0.8), stamp());
      markings.push({
        key: `dissolve: ${opts.key ?? from.toFixed(2)}`,
        kind: "dissolve",
        ...toPicture(area),
        from,
        to: Number(to.toFixed(3)),
      });
      console.log(`${now().toFixed(2)}  DISSOLVE ${(to - from).toFixed(2)} s`);
    },

    /** Scrolls the nearest scrollable ancestor of an element by dy pixels, eased over ms. */
    scrollNear: (locator: Locator, dy: number, ms: number) =>
      locator.evaluate(
        (element, [delta, duration]) =>
          new Promise<void>((resolve) => {
            let e = element.parentElement;
            while (
              e &&
              !(
                e.scrollHeight > e.clientHeight + 1 &&
                /auto|scroll/.test(getComputedStyle(e).overflowY)
              )
            ) {
              e = e.parentElement;
            }
            if (!e) throw new Error("Nothing to scroll.");
            const scroller = e;
            const from = scroller.scrollTop;
            const to = Math.max(
              0,
              Math.min(scroller.scrollHeight - scroller.clientHeight, from + delta),
            );
            const t0 = performance.now();
            const step = (time: number) => {
              const p = Math.min(1, (time - t0) / duration);
              const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
              scroller.scrollTop = from + (to - from) * eased;
              if (p < 1) requestAnimationFrame(step);
              else resolve();
            };
            requestAnimationFrame(step);
          }),
        [dy, ms] as const,
      ),

    /** Drags an element inside `frame` to (x, y) in page coordinates with synthetic mouse
     * events, moving the drawn pointer along with it. */
    async drag(frame: Frame, locator: Locator, x: number, y: number, ms = 1400) {
      const b = await locator.boundingBox();
      const offset = await (await frame.frameElement()).boundingBox();
      if (!b || !offset) throw new Error(`Cannot drag ${String(locator)}: it is not on screen.`);
      const from = { x: b.x + b.width / 2, y: b.y + b.height * 0.4 };
      await r.moveTo(from.x, from.y);
      const fire = (type: string, px: number, py: number, buttons: number) =>
        locator.evaluate(
          (element, [t, cx, cy, bs]) => {
            const target = t === "mousedown" ? element : element.ownerDocument;
            target.dispatchEvent(
              new MouseEvent(t, {
                bubbles: true,
                cancelable: true,
                clientX: cx,
                clientY: cy,
                button: 0,
                buttons: bs,
                view: element.ownerDocument.defaultView,
              }),
            );
          },
          [type, px - offset.x, py - offset.y, buttons] as const,
        );
      presses.push(pointerSample(from.x, from.y));
      await fire("mousedown", from.x, from.y, 1);
      const steps = Math.round(ms / 30);
      for (let i = 1; i <= steps; i++) {
        const p = ease(i / steps);
        const px = from.x + (x - from.x) * p;
        const py = from.y + (y - from.y) * p;
        await fire("mousemove", px, py, 1);
        await page.evaluate(
          ([a, c]) => (window as unknown as VideoWindow).__video.place(a, c),
          [px, py],
        );
        sample(px, py);
        await page.waitForTimeout(30);
      }
      await fire("mouseup", x, y, 0);
      r.cursorX = x;
      r.cursorY = y;
      pointerActed = now();
    },
  };

  const pointerSample = (x: number, y: number): PointerSample => ({
    t: stamp(),
    x: Math.round(x * scale),
    y: Math.round(y * scale),
  });
  /** Logs where the pointer is, while capturing. */
  const sample = (x: number, y: number) => {
    if (capturing) pointer.push(pointerSample(x, y));
  };
  const closeBoxes = (ending: string[]) => {
    const to = stamp();
    for (const key of ending) {
      markings.push({ ...openBoxes.get(key)!, to });
      openBoxes.delete(key);
    }
  };
  /** Waits until `area` looks the same in three captures in a row, 0.1 s apart, or 3 s. */
  const stillIn = async (area: Box) => {
    const clip = { ...area, scale: 0.25 };
    const end = Date.now() + 3000;
    let last = "";
    let same = 0;
    while (same < 2 && Date.now() < end) {
      await page.waitForTimeout(100);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip });
      same = data === last ? same + 1 : 0;
      last = data;
    }
  };

  return r;
}

export type Recorder = Awaited<ReturnType<typeof startRecorder>>;

/** Lays the page out as the video's screen, unscaled, for working out a shot. */
export async function layOut(page: Page, width = 1024, height = 768) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.waitForTimeout(500);
}

const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

const isBox = (b: Box | Locator | Locator[]): b is Box =>
  !Array.isArray(b) && typeof (b as Box).width === "number";
const asList = (l: Locator | Locator[]) => (Array.isArray(l) ? l : [l]);

export const pad = (b: Box, p: number): Box => ({
  x: b.x - p,
  y: b.y - p,
  width: b.width + 2 * p,
  height: b.height + 2 * p,
});

/** The smallest box around all the elements. */
export async function union(locators: Locator[]): Promise<Box> {
  const boxes: Box[] = [];
  for (const l of locators) {
    const b = await l.boundingBox();
    if (!b) throw new Error(`Cannot highlight ${String(l)}: it is not on screen.`);
    boxes.push(b);
  }
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

interface VideoWindow {
  __video: {
    place(x: number, y: number): void;
    show(on: boolean): void;
    ripple(x: number, y: number): void;
    outerBox(box: Box): Box;
  };
}

async function installOverlays(page: Page) {
  await page.evaluate(() => {
    // A take that died part way leaves its overlays behind.
    document
      .querySelectorAll("#video-cursor, .video-ripple, .video-box-probe, #video-style")
      .forEach((e) => e.remove());
    const style = document.createElement("style");
    style.id = "video-style";
    style.textContent = `
      #video-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
        width: 26px; height: 26px; opacity: 0; transition: opacity 300ms;
        filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); }
      .video-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 44px;
        height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid #ffc94a;
        animation: video-ripple 550ms ease-out forwards; }
      @keyframes video-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
      .video-box-probe { position: fixed; visibility: hidden; pointer-events: none; border: 3px solid transparent; }`;
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "video-cursor";
    cursor.innerHTML = `<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15.2 L18.6 15.2 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    document.documentElement.appendChild(cursor);

    (window as unknown as VideoWindow).__video = {
      place(x, y) {
        cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
      },
      show(on) {
        cursor.style.opacity = on ? "1" : "0";
      },
      ripple(x, y) {
        const ring = document.createElement("div");
        ring.className = "video-ripple";
        ring.style.left = `${x}px`;
        ring.style.top = `${y}px`;
        document.documentElement.appendChild(ring);
        setTimeout(() => ring.remove(), 700);
      },
      // The outer edge of a box with a 3px border placed at `box`, as the page's own styles lay
      // it out (whether their box-sizing puts the border outside or not): the edge Coanda draws
      // a marking's border inside.
      outerBox(box) {
        const probe = document.createElement("div");
        probe.className = "video-box-probe";
        Object.assign(probe.style, {
          left: `${box.x}px`,
          top: `${box.y}px`,
          width: `${box.width}px`,
          height: `${box.height}px`,
        });
        document.documentElement.appendChild(probe);
        const b = probe.getBoundingClientRect();
        probe.remove();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      },
    };
  });
}
