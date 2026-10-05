import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { moveOldReviewFiles } from "./migrate.ts";

let root: string;
const OLD = "coanda";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "howbench-migrate-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("old review files and folders take Howbench's names, with the paths in them", () => {
  const lesson = join(root, "lesson");
  mkdirSync(join(lesson, `one.mp4.${OLD}`), { recursive: true });
  mkdirSync(join(lesson, `.${OLD}`));
  writeFileSync(
    join(lesson, `one.mp4.${OLD}.json`),
    JSON.stringify({ reviewed: { copy: `lesson/one.mp4.${OLD}/reviewed.mp4` } }),
  );
  writeFileSync(join(lesson, `.${OLD}`, "questions.json"), `["lesson/.${OLD}/chat/a.png"]`);

  moveOldReviewFiles(root);

  expect(existsSync(join(lesson, `one.mp4.${OLD}.json`))).toBe(false);
  expect(existsSync(join(lesson, "one.mp4.howbench"))).toBe(true);
  expect(JSON.parse(readFileSync(join(lesson, "one.mp4.howbench.json"), "utf8"))).toEqual({
    reviewed: { copy: "lesson/one.mp4.howbench/reviewed.mp4" },
  });
  expect(readFileSync(join(lesson, ".howbench", "questions.json"), "utf8")).toBe(
    '["lesson/.howbench/chat/a.png"]',
  );
});

test("an old file is left where a Howbench one is already in its place", () => {
  writeFileSync(join(root, `a.md.${OLD}.json`), "old");
  writeFileSync(join(root, "a.md.howbench.json"), "new");
  moveOldReviewFiles(root);
  expect(readFileSync(join(root, "a.md.howbench.json"), "utf8")).toBe("new");
  expect(existsSync(join(root, `a.md.${OLD}.json`))).toBe(true);
});
