// Finding and running ffmpeg and ffprobe.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The path of ffmpeg or ffprobe: in $FFMPEG_DIR if set, then where winget installs it on Windows
 * (an older copy earlier on the PATH may lack filters the toolkit uses), then the PATH.
 */
export function findTool(name: "ffmpeg" | "ffprobe"): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [
    process.env.FFMPEG_DIR && join(process.env.FFMPEG_DIR, exe),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", exe),
  ].filter((c): c is string => Boolean(c));
  return candidates.find((c) => existsSync(c)) ?? name;
}

/** A media file's length in seconds. */
export function duration(file: string): number {
  const out = execFileSync(findTool("ffprobe"), [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  const seconds = Number(out.toString().trim());
  if (!Number.isFinite(seconds)) throw new Error(`Could not read the length of ${file}`);
  return seconds;
}

export function ffmpeg(args: string[]): void {
  execFileSync(findTool("ffmpeg"), ["-v", "error", "-y", ...args], { stdio: "inherit" });
}

/** An image's size in pixels. */
export function imageSize(file: string): { width: number; height: number } {
  const out = execFileSync(findTool("ffprobe"), [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0:s=x",
    file,
  ])
    .toString()
    .trim();
  const [width, height] = out.split("x").map(Number);
  if (!(width > 0 && height > 0)) throw new Error(`Could not read the size of ${file}`);
  return { width, height };
}

/** Writes `to` as `from` (any image) converted to `to`'s format, its long edge brought down to
 * `longEdge` if it's longer. */
export function convertImage(from: string, to: string, longEdge?: number): void {
  const scale = longEdge
    ? ["-vf", `scale='if(gt(iw,ih),min(${longEdge},iw),-2)':'if(gt(iw,ih),-2,min(${longEdge},ih))'`]
    : [];
  ffmpeg(["-i", from, ...scale, "-frames:v", "1", to]);
}
