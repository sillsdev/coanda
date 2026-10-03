import { expect, test } from "vite-plus/test";
import { formatTime, initials, stem } from "./format.ts";

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
