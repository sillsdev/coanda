import { expect, test } from "vite-plus/test";
import { formatTime, initials, modelName, stem } from "./format.ts";

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
