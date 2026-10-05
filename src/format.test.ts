import { expect, test } from "vite-plus/test";
import type { TreeNode } from "../shared/types.ts";
import { formatTime, initials, modelName, stem, sumOwned } from "./format.ts";

test("formatTime", () => {
  expect(formatTime(0)).toBe("0:00");
  expect(formatTime(75.4)).toBe("1:15");
  expect(formatTime(Number.NaN)).toBe("0:00");
});

test("initials", () => {
  expect(initials("John Hatton")).toBe("JH");
  expect(initials("Mary Ann Kent")).toBe("MK");
  expect(initials("hatton")).toBe("HA");
});

test("stem drops the extension", () => {
  expect(stem("welcome.webm")).toBe("welcome");
});

test("modelName shows family and version", () => {
  expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
  expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(modelName("opus")).toBe("opus");
});

test("sumOwned leaves out folders that are projects of their own", () => {
  const video = (path: string, open: number): TreeNode => ({
    name: path,
    path,
    kind: "video",
    open,
  });
  const tree: TreeNode[] = [
    video("a.webm", 1),
    {
      name: "p",
      path: "p",
      kind: "folder",
      project: true,
      children: [
        video("p/b.webm", 2),
        { name: "plain", path: "p/plain", kind: "folder", children: [video("p/plain/c.webm", 4)] },
        {
          name: "q",
          path: "p/q",
          kind: "folder",
          project: true,
          children: [video("p/q/d.webm", 8)],
        },
      ],
    },
  ];
  const open = (n: TreeNode) => n.open ?? 0;
  // No project: every project folder is skipped.
  expect(sumOwned(tree, open)).toBe(1);
  // Project p: its own notes, down through plain folders, but not into project q.
  expect(sumOwned(tree[1].children!, open)).toBe(6);
});
