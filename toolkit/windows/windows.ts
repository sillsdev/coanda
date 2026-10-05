// Windows helpers for recording apps that Chromium doesn't draw: finding and waiting for a
// window, keeping it behind the person's windows, photographing it while it is covered, and the
// screens ffmpeg's ddagrab can capture. Each runs a script in this folder in Windows PowerShell;
// arguments go in environment variables, never into the script's text. Rectangles are in
// physical screen pixels, as ffmpeg captures them and UI Automation reports them.
import { execFile, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A visible window above another one and overlapping it. */
export interface WindowAbove {
  pid: number;
  /** The process's name, such as "chrome". */
  process: string;
  className: string;
  frame: Rect;
}

export interface WindowInfo {
  hwnd: number;
  pid: number;
  title: string;
  className: string;
  /** The window as it looks on screen, title bar and borders included. */
  frame: Rect;
  /** The inside of the window, without title bar or borders. */
  client: Rect;
  /** The DPI of the screen the window is mostly on: 96 at 100%, 120 at 125%. */
  dpi: number;
  minimized: boolean;
  /** Kept but not drawn, as on another virtual desktop: UI Automation can't see it. */
  cloaked: boolean;
  foreground: boolean;
  /** Visible windows above this one that overlap it, topmost first: what a screen recording of
   * it would show instead. */
  above: WindowAbove[];
}

/** A screen that ddagrab can capture: `index` is its output_idx. */
export interface Output {
  index: number;
  device: string;
  /** 1 is unrotated. */
  rotation: number;
  box: Rect;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Runs `<name>.ps1` from this folder with `env` added to the environment, and parses the JSON it
 * prints. */
export function runScript<T>(name: string, env: Record<string, string | number | undefined> = {}) {
  return new Promise<T>((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(here, `${name}.ps1`),
      ],
      { env: { ...process.env, ...scriptEnv(env) }, windowsHide: true, maxBuffer: 1 << 24 },
      (error, stdout, stderr) => {
        const text = stdout.trim();
        if (error && !text) {
          reject(new Error(`${name}.ps1 failed: ${stderr.trim() || error.message}`));
          return;
        }
        try {
          resolve(JSON.parse(text) as T);
        } catch {
          reject(new Error(`${name}.ps1 printed something that isn't JSON: ${text}\n${stderr}`));
        }
      },
    );
  });
}

function scriptEnv(env: Record<string, string | number | undefined>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[`HOWBENCH_${key}`] = String(value);
  }
  return out;
}

const rectText = (r: Rect) => [r.x, r.y, r.width, r.height].map(Math.round).join(",");

export interface WindowQuery {
  hwnd?: number;
  pid?: number;
  /** A regular expression the title must match (.NET syntax, ignoring case). */
  title?: string;
}

/** The visible top-level windows that match, topmost first. */
export const findWindows = (q: WindowQuery) =>
  runScript<WindowInfo[]>("find-windows", { HWND: q.hwnd, PID: q.pid, TITLE: q.title });

/** Waits for a matching window, polling with plain Win32 calls that send the app no messages, so
 * a dialog that opens once its app is idle still opens. */
export async function waitForWindow(q: WindowQuery & { timeoutMs?: number }): Promise<WindowInfo> {
  const timeout = q.timeoutMs ?? 30000;
  const hits = await runScript<WindowInfo[]>("find-windows", {
    HWND: q.hwnd,
    PID: q.pid,
    TITLE: q.title,
    TIMEOUT_MS: timeout,
  });
  if (!hits.length) throw new Error(`No window ${JSON.stringify(q)} after ${timeout} ms`);
  return hits[0];
}

/**
 * Puts a window, or every window of a process, behind all other windows without activating it,
 * un-minimizing it first. Use it whenever the app would otherwise come forward while the person
 * works (apps reopen minimized or in front after a restart). With `client`, also moves and
 * sizes the one window so its inside is exactly that rectangle.
 */
export const sendBehind = (target: { hwnd: number } | { pid: number }, client?: Rect) =>
  runScript<WindowInfo[]>("behind", {
    HWND: "hwnd" in target ? target.hwnd : undefined,
    PID: "pid" in target ? target.pid : undefined,
    CLIENT_RECT: client && rectText(client),
  });

/**
 * Brings a window to the front and gives it the focus. Only for a recording the person has
 * agreed to, since it takes the screen from them.
 */
export const bringToFront = (hwnd: number) => runScript<WindowInfo>("front", { HWND: hwnd });

/** Saves a PNG of a window even while other windows cover it. The image is in the window's own
 * pixels. With `client`, only its inside. */
export const printWindow = (hwnd: number, out: string, opts: { client?: boolean } = {}) =>
  runScript<{ file: string; width: number; height: number }>("print-window", {
    HWND: hwnd,
    OUT: out,
    CLIENT: opts.client ? 1 : 0,
  });

/** The screens ddagrab can capture, numbered as its output_idx. */
export const outputs = () => runScript<Output[]>("outputs");

/** The windows above `info` that belong to other processes: anything a recording of it would
 * show that isn't the app. */
export const othersAbove = (info: WindowInfo) => info.above.filter((w) => w.pid !== info.pid);

/** What watchAbove reports. */
export interface AboveChange {
  /** Seconds since the epoch. */
  t: number;
  above: WindowAbove[];
  minimized: boolean;
  /** The window has closed: what was behind it shows now. */
  gone: boolean;
}

/**
 * Watches the windows above `hwnd` that overlap `area` (default the window's frame), calling
 * `onChange` at the start and whenever they change, until `stop()` is called or the window goes
 * away.
 */
export function watchAbove(
  hwnd: number,
  onChange: (change: AboveChange) => void,
  opts: { area?: Rect; intervalMs?: number } = {},
) {
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(here, "watch-above.ps1"),
    ],
    {
      env: {
        ...process.env,
        ...scriptEnv({
          HWND: hwnd,
          AREA: opts.area && rectText(opts.area),
          INTERVAL_MS: opts.intervalMs,
          PARENT_PID: process.pid,
        }),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const exited = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
  const ready = new Promise<void>((resolve) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      onChange(JSON.parse(line) as AboveChange);
      resolve();
    });
    void exited.then(resolve);
  });
  return {
    /** Resolves once the first report is in. */
    ready,
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
    },
  };
}
