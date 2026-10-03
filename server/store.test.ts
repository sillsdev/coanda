import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { Store } from "./store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "coanda-store-"));
  mkdirSync(join(root, "lessons", "one.mp4.coanda"), { recursive: true });
  mkdirSync(join(root, "empty"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "lessons", "one.mp4"), "");
  writeFileSync(join(root, "lessons", "notes.txt"), "");
  writeFileSync(join(root, "intro.webm"), "");
  writeFileSync(join(root, ".hidden", "secret.mp4"), "");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("tree lists every folder, then the files, and skips Coanda's own files and hidden folders", () => {
  writeFileSync(join(root, "lessons", "one.mp4.coanda.json"), '{"annotations":[]}');
  const tree = new Store(root).tree();
  expect(tree.map((n) => n.path)).toEqual(["empty", "lessons", "intro.webm"]);
  expect(tree[1].children?.map((n) => [n.path, n.kind])).toEqual([
    ["lessons/notes.txt", "file"],
    ["lessons/one.mp4", "video"],
  ]);
});

test("annotation counts come from the file next to the video", () => {
  const store = new Store(root);
  const base = {
    kind: "pin" as const,
    x: 1,
    y: 1,
    t: 0,
    author: "A",
    text: "x",
    thread: [],
    createdAt: "",
  };
  store.write("intro.webm", {
    annotations: [
      { ...base, id: 1, status: "open" },
      { ...base, id: 2, status: "sent" },
      { ...base, id: 3, status: "resolved" },
    ],
  });
  const intro = store.tree().find((n) => n.path === "intro.webm")!;
  expect(intro).toMatchObject({ unresolved: 2, open: 1, sent: 1 });
});

test("paths outside the folder are refused", () => {
  expect(() => new Store(root).resolvePath("../elsewhere.mp4")).toThrow(/outside/);
});

test("in a project, the planning documents come first, in step order", () => {
  writeFileSync(join(root, "lessons", "video-project.json"), "{}");
  writeFileSync(join(root, "lessons", "script.md"), "");
  writeFileSync(join(root, "lessons", "brief.md"), "");
  mkdirSync(join(root, "lessons", "assets"));
  const lessons = new Store(root).tree()[1].children!;
  expect(lessons.map((n) => [n.name, n.step])).toEqual([
    ["brief.md", 1],
    ["script.md", 3],
    ["assets", undefined],
    ["notes.txt", undefined],
    ["one.mp4", undefined],
    ["video-project.json", undefined],
  ]);
});
