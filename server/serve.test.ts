import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type { Annotation, AnnotationFile } from "../shared/types.ts";
import { byteRange, serve } from "./serve.ts";

test("a range asks for those bytes", () => {
  expect(byteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
  expect(byteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
  expect(byteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
});

test("a range reaching past the file stops at its end", () => {
  expect(byteRange("bytes=-1000", 100)).toEqual({ start: 0, end: 99 });
  expect(byteRange("bytes=50-1000", 100)).toEqual({ start: 50, end: 99 });
});

test("a range with none of the file in it is unsatisfiable, a malformed one is ignored", () => {
  expect(byteRange("bytes=100-", 100)).toBe("unsatisfiable");
  expect(byteRange("bytes=-0", 100)).toBe("unsatisfiable");
  expect(byteRange("bytes=-", 100)).toBeNull();
  expect(byteRange("bytes=20-10", 100)).toBeNull();
  expect(byteRange("items=0-1", 100)).toBeNull();
  expect(byteRange(undefined, 100)).toBeNull();
});

let dir: string;
let root: string;
let server: { close: () => void; port: number } | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coanda-serve-"));
  root = join(dir, "videos");
  mkdirSync(join(root, "lessons"), { recursive: true });
});

afterEach(() => {
  server?.close();
  server = undefined;
  // A stopped session's process can hold the folder for a moment on Windows.
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const note = (id: number, status: Annotation["status"]): Annotation => ({
  id,
  kind: "pin",
  x: 1,
  y: 1,
  t: 0,
  author: "A",
  text: `note ${id}`,
  status,
  thread: [],
  createdAt: "",
});

const annotate = (video: string, ...annotations: Annotation[]) => {
  writeFileSync(join(root, video), "");
  writeFileSync(join(root, `${video}.coanda.json`), JSON.stringify({ annotations }));
};

const statuses = (video: string) =>
  (
    JSON.parse(readFileSync(join(root, `${video}.coanda.json`), "utf8")) as AnnotationFile
  ).annotations.map((a) => a.status);

async function start(claudeCommand?: string[]) {
  server = await serve({
    root,
    port: 0,
    user: "Tester",
    configFile: join(dir, "config.json"),
    sessionsFile: join(dir, "sessions.json"),
    claudeCommand,
  });
  const url = (p: string) => `http://127.0.0.1:${server!.port}${p}`;
  return {
    get: async (p: string) => (await fetch(url(p))).json(),
    post: async (p: string) => (await fetch(url(p), { method: "POST" })).json(),
  };
}

test("one Send goes to one waiting `coanda wait`, not to every one", async () => {
  annotate("intro.mp4", note(1, "open"));
  const api = await start();
  const first = api.get("/api/wait?hold=2");
  const second = api.get("/api/wait?hold=2");
  await new Promise((r) => setTimeout(r, 200));
  await api.post("/api/send");
  const got = (await Promise.all([first, second])) as { id: number }[][];
  expect(got.map((g) => g.length).sort((a, b) => a - b)).toEqual([0, 1]);
});

test("a project's Send leaves the notes of a project inside it alone", async () => {
  writeFileSync(join(root, "video-project.json"), "{}");
  writeFileSync(join(root, "lessons", "video-project.json"), "{}");
  annotate("intro.mp4", note(1, "open"));
  annotate("lessons/demo.mp4", note(1, "open"));
  // A session that never answers, so nothing it does changes the notes.
  const api = await start([process.execPath, "-e", "setInterval(() => {}, 1000)", "--"]);
  await api.post("/api/send?project=");
  expect(statuses("intro.mp4")).toEqual(["sent"]);
  expect(statuses("lessons/demo.mp4")).toEqual(["open"]);
});

test("`coanda wait` never gets notes that belong to a project", async () => {
  writeFileSync(join(root, "lessons", "video-project.json"), "{}");
  annotate("intro.mp4", note(1, "sent"));
  annotate("lessons/demo.mp4", note(1, "sent"));
  const api = await start();
  const got = (await api.get("/api/wait?hold=1")) as { video: string }[];
  expect(got.map((a) => a.video)).toEqual(["intro.mp4"]);
});

test("notes a failed session never answered go back to open", async () => {
  writeFileSync(join(root, "lessons", "video-project.json"), "{}");
  annotate("lessons/demo.mp4", note(1, "open"));
  const failing = join(dir, "failing.mjs");
  writeFileSync(failing, 'process.stdin.once("data", () => process.exit(1));\n');
  const api = await start([process.execPath, failing]);
  await api.post("/api/send?project=lessons");
  for (let i = 0; i < 50 && statuses("lessons/demo.mp4")[0] !== "open"; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(statuses("lessons/demo.mp4")).toEqual(["open"]);
});

test("notes sent again after a failure stay sent", async () => {
  writeFileSync(join(root, "lessons", "video-project.json"), "{}");
  annotate("lessons/demo.mp4", note(1, "open"));
  // Fails the first time, then waits like a working session.
  const marker = join(dir, "failed-once");
  const failOnce = join(dir, "fail-once.mjs");
  writeFileSync(
    failOnce,
    `import { existsSync, writeFileSync } from "node:fs";
const marker = ${JSON.stringify(marker)};
if (existsSync(marker)) setInterval(() => {}, 1000);
else process.stdin.once("data", () => { writeFileSync(marker, ""); process.exit(1); });
`,
  );
  const api = await start([process.execPath, failOnce]);
  await api.post("/api/send?project=lessons");
  for (let i = 0; i < 50 && statuses("lessons/demo.mp4")[0] !== "open"; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(statuses("lessons/demo.mp4")).toEqual(["open"]);
  await api.post("/api/send?project=lessons");
  await new Promise((r) => setTimeout(r, 500));
  expect(statuses("lessons/demo.mp4")).toEqual(["sent"]);
});

test("a server that can't take its port stops watching the folder", async () => {
  const first = await start();
  expect(first).toBeTruthy();
  const watchers = () => process.getActiveResourcesInfo().filter((r) => r === "FSEventWrap").length;
  await new Promise((r) => setTimeout(r, 100));
  const before = watchers();
  await expect(
    serve({
      root,
      port: server!.port,
      user: "Tester",
      configFile: join(dir, "config.json"),
      sessionsFile: join(dir, "sessions.json"),
    }),
  ).rejects.toThrow();
  // A watcher's handle goes once its close has been processed.
  await new Promise((r) => setTimeout(r, 100));
  expect(watchers()).toBe(before);
});
