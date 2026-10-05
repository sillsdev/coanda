import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { Store } from "./store.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "howbench-store-"));
  mkdirSync(join(root, "lessons", "one.mp4.howbench"), { recursive: true });
  mkdirSync(join(root, "empty"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "lessons", "one.mp4"), "");
  writeFileSync(join(root, "lessons", "notes.txt"), "");
  writeFileSync(join(root, "intro.webm"), "");
  writeFileSync(join(root, ".hidden", "secret.mp4"), "");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("tree lists every folder, then the files, and skips HowBench's own files and hidden folders", () => {
  writeFileSync(join(root, "lessons", "one.mp4.howbench.json"), '{"annotations":[]}');
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

test("renaming a video takes its notes' saved frames and images with it", () => {
  const store = new Store(root);
  writeFileSync(join(root, "lessons", "one.mp4.howbench", "1.png"), "");
  const reviewed = join(root, "lessons", "one.mp4.howbench", "reviewed-x.mp4");
  store.write("lessons/one.mp4", {
    annotations: [
      {
        id: 1,
        kind: "pin",
        x: 1,
        y: 1,
        t: 0,
        author: "A",
        text: "x",
        status: "open",
        createdAt: "",
        frame: "lessons/one.mp4.howbench/1.png",
        images: ["lessons/one.mp4.howbench/pasted-a.png"],
        thread: [
          { who: "user", text: "y", at: "", images: ["lessons/one.mp4.howbench/pasted-b.png"] },
        ],
      },
    ],
    reviewed: { copy: reviewed },
  });
  store.rename("lessons/one.mp4", "two.mp4");
  const data = store.read("lessons/two.mp4");
  const a = data.annotations[0];
  expect(a.frame).toBe("lessons/two.mp4.howbench/1.png");
  expect(a.images).toEqual(["lessons/two.mp4.howbench/pasted-a.png"]);
  expect(a.thread[0].images).toEqual(["lessons/two.mp4.howbench/pasted-b.png"]);
  expect(data.reviewed?.copy).toBe(join(root, "lessons", "two.mp4.howbench", "reviewed-x.mp4"));

  store.rename("lessons", "units");
  expect(store.read("units/two.mp4").annotations[0].frame).toBe("units/two.mp4.howbench/1.png");
});

test("deleting a video takes the render's files named after it, unless another video shares them", () => {
  const store = new Store(root);
  for (const f of ["one.srt", "one.en.vtt", "one.timeline.json", "one.voice.json", "onex.srt"]) {
    writeFileSync(join(root, "lessons", f), "");
  }
  const names = () =>
    store
      .withSidecars("lessons/one.mp4")
      .map((f) => f.slice(join(root, "lessons").length + 1))
      .sort();
  expect(names()).toEqual([
    "one.en.vtt",
    "one.mp4",
    "one.mp4.howbench",
    "one.srt",
    "one.timeline.json",
    "one.voice.json",
  ]);
  writeFileSync(join(root, "lessons", "one.webm"), "");
  expect(names()).toEqual(["one.mp4", "one.mp4.howbench"]);
});

test("paths outside the folder are refused", () => {
  expect(() => new Store(root).resolvePath("../elsewhere.mp4")).toThrow(/outside/);
});

test("in a project, the planning documents and its videos come first, in step order", () => {
  writeFileSync(join(root, "lessons", "video-project.json"), "{}");
  writeFileSync(join(root, "lessons", "script.md"), "");
  writeFileSync(join(root, "lessons", "brief.md"), "");
  writeFileSync(join(root, "lessons", "voiced.mp4"), "");
  writeFileSync(join(root, "lessons", "draft.mp4"), "");
  mkdirSync(join(root, "lessons", "assets"));
  mkdirSync(join(root, "lessons", "assets", "drafts"));
  writeFileSync(join(root, "lessons", "assets", "drafts", "draft.mp4"), "");
  const lessons = new Store(root).tree()[1].children!;
  expect(lessons[4].children![0].children!.map((n) => [n.name, n.step])).toEqual([
    ["draft.mp4", 4],
  ]);
  expect(lessons.map((n) => [n.name, n.step])).toEqual([
    ["brief.md", 1],
    ["script.md", 3],
    ["draft.mp4", 4],
    ["voiced.mp4", 5],
    ["assets", undefined],
    ["notes.txt", undefined],
    ["one.mp4", undefined],
    ["video-project.json", undefined],
  ]);
});

test("saving a document replaces all of its text, and never recreates a missing one", () => {
  const store = new Store(root);
  const file = join(root, "brief.md");
  writeFileSync(file, "A long first version of the brief.\n");
  const first = store.readDoc("brief.md");
  const saved = store.writeDoc("brief.md", "Short.\n", first!.mtime);
  expect(saved).toMatchObject({ text: "Short.\n" });
  expect(readFileSync(file, "utf8")).toBe("Short.\n");
  rmSync(file);
  expect(store.writeDoc("brief.md", "Again.\n", 0)).toBe("missing");
  expect(existsSync(file)).toBe(false);
});
