// Records a window or a rectangle of a Windows screen for a video, for apps that Chromium doesn't
// draw (WinForms, WPF, the system's own dialogs), which toolkit/recorder.ts can't see. It films
// the screen with ffmpeg's ddagrab and writes the take folder's screen.mp4 and events.json
// directly, in recorder.ts's format, so `howbench assemble`, `howbench subtitles` and the highlight
// boxes work unchanged (there is no frames folder: skip `howbench frames`).
//
// ddagrab, not gdigrab: ddagrab takes frames from the Desktop Duplication API on the GPU and
// keeps a steady 30 fps at full size, and it captures what apps draw on the GPU (WebView2, WPF).
// gdigrab copies the screen with GDI on the CPU, which falls behind on large or high-DPI screens.
// ffmpeg stamps each frame with the wall clock (-use_wallclock_as_timestamps) and reports the
// first frame's time, which becomes events.json's `start`, so the video's 0 is the log's 0.
//
// The system pointer is left out of the picture (draw_mouse=0): an app driven through UI
// Automation never moves it, and the person's own pointer may be anywhere. The pointer in the
// video is the one this recorder logs, which Howbench draws. Pass `drawMouse: true` only when the
// project really moves the mouse during the take.
//
// Driving the app is the project's business (UI Automation, MSAA, the app's own API). This logs
// what the project does: narration, actions, the pointer's path, presses and keystrokes, boxes,
// arrows and dissolves, all given in physical screen pixels and turned into picture pixels here.
// Its pacing is recorder.ts's: `clickBeat`, `typeBeat`, `minBoxSeconds` and `glideMs`.
//
// Whatever covers the recorded rectangle is recorded. Before capture starts, the recorder refuses
// if another app's window is over it; during the take it watches, and warns with the times if
// one comes over it, so those frames can be checked and the take deleted if they show anything
// private.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Marking, PointerSample } from "../shared/types.ts";
import { ffmpeg, findTool } from "./ffmpeg.ts";
import {
  estimateSpeech,
  glideMs,
  SECONDS_PER_WORD,
  typingRhythm,
  type Box,
  type TakeEvents,
} from "./recorder.ts";
import {
  findWindows,
  outputs,
  watchAbove,
  type Output,
  type Rect,
  type WindowAbove,
  type WindowInfo,
} from "./windows/windows.ts";

/** Where ddagrab captures: screen `output`, from (offsetX, offsetY) on it, `width` x `height`
 * (both even, as the video needs). (x, y) is the same corner in desktop coordinates. */
export interface CaptureArea {
  output: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

/** The capture area for `rect` (desktop pixels), which must lie on one screen. Odd sizes lose
 * their last column or row. */
export function captureArea(rect: Rect, screens: Output[]): CaptureArea {
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  const right = Math.round(rect.x + rect.width);
  const bottom = Math.round(rect.y + rect.height);
  const screen = screens.find(
    (s) =>
      x >= s.box.x &&
      y >= s.box.y &&
      right <= s.box.x + s.box.width &&
      bottom <= s.box.y + s.box.height,
  );
  if (!screen) {
    throw new Error(
      `The rectangle ${x},${y} ${right - x}x${bottom - y} is not all on one screen ` +
        `(screens: ${screens.map((s) => `${s.box.x},${s.box.y} ${s.box.width}x${s.box.height}`).join("; ")})`,
    );
  }
  const even = (n: number) => Math.floor(n / 2) * 2;
  return {
    output: screen.index,
    offsetX: x - screen.box.x,
    offsetY: y - screen.box.y,
    width: even(right - x),
    height: even(bottom - y),
    x,
    y,
  };
}

/** ffmpeg's arguments for filming `area` into `file`, fast enough to keep up; finish() then
 * makes the steady 30 fps screen.mp4 from it. */
export function ddagrabArgs(
  area: CaptureArea,
  file: string,
  opts: { drawMouse?: boolean; framerate?: number; maxSeconds?: number } = {},
): string[] {
  const source = [
    `output_idx=${area.output}`,
    `draw_mouse=${opts.drawMouse ? 1 : 0}`,
    `framerate=${opts.framerate ?? 30}`,
    `offset_x=${area.offsetX}`,
    `offset_y=${area.offsetY}`,
    `video_size=${area.width}x${area.height}`,
  ].join(":");
  return [
    "-y",
    "-hide_banner",
    "-use_wallclock_as_timestamps",
    "1",
    "-f",
    "lavfi",
    "-i",
    `ddagrab=${source}`,
    "-vf",
    "hwdownload,format=bgra,format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "16",
    // A take whose script died part way can't leave ffmpeg filming the screen for ever.
    "-t",
    String(opts.maxSeconds ?? 900),
    file,
  ];
}

/** The first frame's time in seconds since the epoch, from ffmpeg's report on its input
 * ("Duration: N/A, start: 1759561234.123456, bitrate: N/A"). */
export function parseStart(stderr: string): number | undefined {
  const m = stderr.match(/\bstart: (\d{9,}\.\d+)/);
  return m ? Number(m[1]) : undefined;
}

const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/** Points along an eased glide from `from` to `to` over `seconds`, starting at take time `t0`,
 * one per 1/30 s and one at the end. */
export function glide(
  from: { x: number; y: number },
  to: { x: number; y: number },
  t0: number,
  seconds: number,
): PointerSample[] {
  const steps = Math.max(1, Math.round(seconds * 30));
  return Array.from({ length: steps }, (_, i) => {
    const p = ease((i + 1) / steps);
    return {
      t: Number((t0 + (seconds * (i + 1)) / steps).toFixed(3)),
      x: Math.round(from.x + (to.x - from.x) * p),
      y: Math.round(from.y + (to.y - from.y) * p),
    };
  });
}

export interface ScreenRecorderOptions {
  /** Where the take goes; emptied first. */
  takeDir: string;
  /** The window to film, by handle (see windows/windows.ts); its inside unless `client` is
   * false. Or give `rect`. */
  hwnd?: number;
  client?: boolean;
  /** A rectangle of the desktop to film, in physical screen pixels. */
  rect?: Rect;
  /** Picture pixels per layout pixel, for how big highlight borders are drawn. Defaults to the
   * window's screen scaling (1.25 at 125%), or 1 for a rectangle. */
  scale?: number;
  secondsPerWord?: number;
  /** Seconds from a press's ripple to the project's click. Default 0.3. */
  clickBeat?: number;
  /** The least seconds between the pointer's last move or press and the first key typed.
   * Default 0.6. */
  typeBeat?: number;
  /** The least seconds a box or arrow stays up: unhighlight() waits until then. Default 2. */
  minBoxSeconds?: number;
  /** Film the system pointer too. Off by default: the logged pointer is drawn instead. */
  drawMouse?: boolean;
  framerate?: number;
  /** Filming stops by itself after this long, in case the script dies (default 900). */
  maxSeconds?: number;
  /** Process names (such as "msedgewebview2") whose windows over the recorded window count as
   * the app's own: popups that another process draws. */
  appProcesses?: string[];
}

/** A stretch of the take during which something other than the app may show in what was
 * filmed: other windows over it, or the window minimized or closed. */
export interface Covered {
  from: number;
  to: number;
  windows: WindowAbove[];
  minimized?: boolean;
  gone?: boolean;
}

export async function startScreenRecorder(opts: ScreenRecorderOptions) {
  const { takeDir } = opts;
  if (process.platform !== "win32") throw new Error("The screen recorder runs only on Windows.");
  if ((opts.hwnd === undefined) === (opts.rect === undefined)) {
    throw new Error("Give the screen recorder a window (hwnd) or a rectangle (rect): one of them.");
  }
  const perWord = opts.secondsPerWord ?? SECONDS_PER_WORD;
  const clickBeat = opts.clickBeat ?? 0.3;
  const typeBeat = opts.typeBeat ?? 0.6;
  const minBoxSeconds = opts.minBoxSeconds ?? 2;
  let windowInfo: WindowInfo | undefined;
  let rect = opts.rect;
  if (opts.hwnd !== undefined) {
    [windowInfo] = await findWindows({ hwnd: opts.hwnd });
    if (!windowInfo) throw new Error(`No visible window ${opts.hwnd}`);
    rect = opts.client === false ? windowInfo.frame : windowInfo.client;
  }
  const area = captureArea(rect!, await outputs());
  const scale = opts.scale ?? (windowInfo ? windowInfo.dpi / 96 : 1);
  const appProcesses = new Set((opts.appProcesses ?? []).map((p) => p.toLowerCase()));
  const pictureRect = { x: area.x, y: area.y, width: area.width, height: area.height };
  /** Windows over the filmed rectangle that aren't the app's. */
  const intruders = (above: WindowAbove[]) =>
    above.filter((w) => w.pid !== windowInfo?.pid && !appProcesses.has(w.process.toLowerCase()));

  rmSync(takeDir, { recursive: true, force: true });
  mkdirSync(takeDir, { recursive: true });
  const captureFile = join(takeDir, "capture.mkv");

  const events: TakeEvents["events"] = [];
  const markings: Marking[] = [];
  /** Boxes and arrows on screen, by their keys. */
  const openBoxes = new Map<string, Omit<Marking, "to">>();
  const pointer: PointerSample[] = [];
  const presses: PointerSample[] = [];
  const keys: number[] = [];
  const covered: Covered[] = [];
  let capturing = false;
  /** When the pointer last moved or pressed, in take seconds. */
  let pointerActed = -Infinity;
  let start = 0;
  let stopCapture: (() => Promise<void>) | undefined;
  let stopWatching: (() => Promise<void>) | undefined;
  const now = () => Date.now() / 1000 - start;
  const stamp = () => Number(now().toFixed(3));
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const toPicture = (b: Box): Box => ({
    x: Math.round(b.x - area.x),
    y: Math.round(b.y - area.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  });
  const pointerSample = (x: number, y: number, t = stamp()): PointerSample => ({
    t,
    x: Math.round(x - area.x),
    y: Math.round(y - area.y),
  });
  const closeBoxes = (ending: string[]) => {
    const to = stamp();
    for (const key of ending) {
      markings.push({ ...openBoxes.get(key)!, to });
      openBoxes.delete(key);
    }
  };

  const r = {
    takeDir,
    /** What is filmed, in desktop pixels. */
    area: pictureRect,
    scale,
    /** The window filmed, as it was when the recorder started. */
    window: windowInfo,
    now,
    toPicture,
    /** Logs an action, which becomes an anchor in the picture's timeline. */
    log(what: string) {
      events.push({ t: stamp(), what });
      console.log(`${now().toFixed(2)}  ${what}`);
    },
    async at(t: number) {
      await sleep((t - now()) * 1000);
    },
    wait: (seconds: number) => sleep(seconds * 1000),

    /**
     * Starts filming once the first frame is in. Refuses if another app's window covers what
     * would be filmed; the window must already be in front, which the project arranges, with
     * the person's go-ahead (see windows.ts's bringToFront).
     */
    async startCapture() {
      if (opts.hwnd !== undefined) {
        const [info] = await findWindows({ hwnd: opts.hwnd });
        if (!info || info.minimized || info.cloaked) {
          throw new Error(`Window ${opts.hwnd} is not on screen to film.`);
        }
        const over = intruders(info.above);
        if (over.length) {
          throw new Error(
            `Not filming: other windows cover the window: ${describe(over)}. ` +
              `Bring it to the front first (with the person's go-ahead).`,
          );
        }
      }
      const capture = await startFfmpeg(ddagrabArgs(area, captureFile, opts));
      start = capture.start;
      stopCapture = capture.stop;
      capturing = true;
      if (opts.hwnd !== undefined) {
        const hwnd = opts.hwnd;
        let open: Covered | undefined;
        const watcher = watchAbove(
          hwnd,
          (change) => {
            const over = intruders(change.above);
            const t = Number((change.t - start).toFixed(3));
            if (open) {
              open.to = t;
              open = undefined;
            }
            if (over.length || change.minimized || change.gone) {
              open = { from: t, to: t, windows: over };
              if (change.minimized) open.minimized = true;
              if (change.gone) open.gone = true;
              covered.push(open);
              console.warn(`${t.toFixed(2)}  COVERED ${describeCovered(open)}`);
            }
          },
          { area: pictureRect },
        );
        stopWatching = async () => {
          await watcher.stop();
          if (open) open.to = stamp();
        };
        await watcher.ready;
      }
    },

    /**
     * Stops filming and writes screen.mp4 (steady 30 fps, from the first frame) and events.json.
     * Returns the stretches when other windows covered what was filmed: look at those frames,
     * and delete the take at once if they show anything of the person's own.
     */
    async finish(): Promise<{ screen: string; covered: Covered[] }> {
      await stopWatching?.();
      closeBoxes([...openBoxes.keys()]);
      markings.sort((a, b) => a.from - b.from);
      capturing = false;
      await stopCapture?.();
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
      const screen = join(takeDir, "screen.mp4");
      ffmpeg([
        "-i",
        captureFile,
        "-vf",
        "fps=30,format=yuv420p",
        "-c:v",
        "libx264",
        "-crf",
        "16",
        "-preset",
        "slow",
        screen,
      ]);
      rmSync(captureFile, { force: true });
      console.log(`${screen}, ${area.width}x${area.height}`);
      for (const c of covered) {
        console.warn(`Covered ${c.from.toFixed(2)}-${c.to.toFixed(2)} s: ${describeCovered(c)}`);
      }
      return { screen, covered };
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

    // The pointer Howbench draws, logged in screen pixels. It starts off the picture, at its
    // bottom right. Nothing here moves the system pointer.
    cursorX: area.x + area.width + 16,
    cursorY: area.y + area.height + 32,
    /** Glides the pointer to (x, y) over `ms`, or `glideMs` of the distance, taking that long. */
    async moveTo(x: number, y: number, ms?: number) {
      ms ??= glideMs(Math.hypot(x - r.cursorX, y - r.cursorY) / scale);
      const t0 = now();
      if (capturing) {
        pointer.push(pointerSample(r.cursorX, r.cursorY));
        for (const p of glide({ x: r.cursorX, y: r.cursorY }, { x, y }, t0, ms / 1000)) {
          pointer.push(pointerSample(p.x, p.y, p.t));
        }
      }
      r.cursorX = x;
      r.cursorY = y;
      await r.at(t0 + ms / 1000);
      pointerActed = now();
    },
    /** Glides the pointer onto a rectangle, such as a control's UI Automation bounding
     * rectangle, at a fraction (fx, fy) of it. */
    moveToRect: (box: Box, ms?: number, fx = 0.5, fy = 0.5) =>
      r.moveTo(box.x + box.width * fx, box.y + box.height * fy, ms),
    /** Logs a press where the pointer is, which Howbench shows as a ripple, without clicking. */
    ripple() {
      presses.push(pointerSample(r.cursorX, r.cursorY));
      pointerActed = now();
    },
    /** Logs a press where the pointer is, then, `clickBeat` later, runs `act`: the project's
     * own click (UI Automation Invoke, an MSAA default action, a real click). */
    async click(act?: () => unknown) {
      r.ripple();
      await r.wait(clickBeat);
      await act?.();
    },
    async moveAndClick(box: Box, act?: () => unknown, ms?: number, fx = 0.5, fy = 0.5) {
      await r.moveToRect(box, ms, fx, fy);
      await r.wait(0.25);
      await r.click(act);
    },
    /** Types `text` like a person through `send`, the project's way to type one character,
     * starting at least `typeBeat` after the pointer last moved or pressed. */
    async type(text: string, send: (ch: string) => unknown, msPerChar = 75) {
      await r.at(pointerActed + typeBeat);
      const rhythm = typingRhythm(text);
      let i = 0;
      for (const ch of text) {
        keys.push(stamp());
        await send(ch);
        await r.wait((msPerChar / 1000) * rhythm[i++]);
      }
    },
    /** Logs a keystroke, such as Enter, and runs `press`, the project's way to press it. */
    async key(press?: () => unknown) {
      keys.push(stamp());
      await press?.();
    },

    // Boxes, arrows and dissolves, logged as markings in picture pixels and take seconds.
    /** Starts a box whose outside edge is `box`, in screen pixels. */
    async highlight(id: string, box: Box) {
      if (openBoxes.has(`box: ${id}`)) await r.unhighlight(id);
      const key = `box: ${id}`;
      openBoxes.set(key, { key, kind: "box", ...toPicture(box), from: stamp() });
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
    /** Starts an arrow on `side` of `box` (screen pixels), pointing at it. unhighlight(id) ends
     * it, with the box of the same id if there is one. */
    async arrow(id: string, box: Box, side: NonNullable<Marking["side"]> = "left") {
      if (openBoxes.has(`arrow: ${id}`)) await r.unhighlight(id);
      const key = `arrow: ${id}`;
      openBoxes.set(key, { key, kind: "arrow", side, ...toPicture(box), from: stamp() });
      console.log(`${now().toFixed(2)}  ARROW ${id}`);
    },
    /**
     * Runs `action`, which makes something appear at once (a paste), so that it dissolves in: the
     * frame from just before the action fades away over `seconds`, or until the action is done
     * if that is later. `region` (screen pixels) limits the dissolve to that part of the picture.
     */
    async dissolve(
      action: () => unknown,
      opts: { seconds?: number; region?: Box; key?: string } = {},
    ) {
      const region = opts.region ?? pictureRect;
      const from = stamp();
      await action();
      const to = Math.max(from + (opts.seconds ?? 0.8), stamp());
      markings.push({
        key: `dissolve: ${opts.key ?? from.toFixed(2)}`,
        kind: "dissolve",
        ...toPicture(region),
        from,
        to: Number(to.toFixed(3)),
      });
      console.log(`${now().toFixed(2)}  DISSOLVE ${(to - from).toFixed(2)} s`);
    },
  };

  return r;
}

export type ScreenRecorder = Awaited<ReturnType<typeof startScreenRecorder>>;

const describe = (windows: WindowAbove[]) =>
  windows.map((w) => `${w.process || w.className} (pid ${w.pid})`).join(", ");

const describeCovered = (c: Covered) =>
  [c.gone && "the window closed", c.minimized && "the window minimized", describe(c.windows)]
    .filter(Boolean)
    .join("; ");

/** Starts ffmpeg and waits for its first frame. `stop` ends it cleanly, as typing q would. */
async function startFfmpeg(args: string[]) {
  const child = spawn(findTool("ffmpeg"), args, {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  // If the script ends without finish(), stop filming with it.
  const killOnExit = () => child.kill();
  process.once("exit", killOnExit);
  child.on("exit", () => process.off("exit", killOnExit));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  const start = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ffmpeg did not start capturing:\n${stderr}`));
    }, 15000);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-20000);
      const t = parseStart(stderr);
      if (t !== undefined) {
        clearTimeout(timer);
        resolve(t);
      }
    });
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg exited (${code}) before capturing:\n${stderr}`));
    });
  });
  return {
    start,
    stop: async () => {
      if (child.exitCode === null) child.stdin.write("q");
      const timer = setTimeout(() => child.kill(), 15000);
      const code = await exited;
      clearTimeout(timer);
      if (code !== 0)
        throw new Error(`ffmpeg failed while capturing (${code}):\n${stderr.slice(-2000)}`);
    },
  };
}
