// Generates the small WebM videos in samples/ that the end-to-end tests annotate.
// Needs ffmpeg on PATH. Run with: node scripts/make-sample-videos.ts
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "samples");

const videos = [
  { path: "getting-started/welcome.webm", source: "testsrc=size=640x360:rate=24", tone: 440 },
  {
    path: "getting-started/first-project.webm",
    source: "smptebars=size=640x360:rate=24",
    tone: 523,
  },
  { path: "advanced/editing-tips.webm", source: "testsrc2=size=640x360:rate=24", tone: 659 },
];

for (const v of videos) {
  const out = join(root, v.path);
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `${v.source}:duration=12`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${v.tone}:duration=12`,
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "150k",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-shortest",
      out,
    ],
    { stdio: "inherit" },
  );
  console.log("wrote", out);
}
