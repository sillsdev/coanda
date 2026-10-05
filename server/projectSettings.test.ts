import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { ProjectSettingsStore } from "./projectSettings.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "howreel-settings-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a project saved with its app's folder as `bloom` keeps it as `app`", () => {
  const file = join(dir, "projects.json");
  writeFileSync(file, JSON.stringify({ "c:/videos/one": { bloom: "D:\\bloom", model: "opus" } }));
  const store = new ProjectSettingsStore(file);
  expect(store.get("C:\\videos\\one")).toEqual({ app: "D:\\bloom", model: "opus" });

  store.set("C:\\videos\\one", { ...store.get("C:\\videos\\one"), effort: "high" });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    "c:/videos/one": { app: "D:\\bloom", model: "opus", effort: "high" },
  });
});
