import { expect, test } from "vite-plus/test";
import { glideMs, typingRhythm } from "./recorder.ts";

test("a pointer move takes 400 ms plus 0.7 ms per pixel, at most 1.1 s", () => {
  expect(glideMs(0)).toBe(400);
  expect(glideMs(500)).toBe(750);
  expect(glideMs(1000)).toBe(1100);
  expect(glideMs(3000)).toBe(1100);
});

test("typing rhythm is uneven but the same each time for the same text", () => {
  const a = typingRhythm("Mi primer libro");
  expect(a).toEqual(typingRhythm("Mi primer libro"));
  expect(a).toHaveLength(15);
  expect(new Set(a.map((x) => x.toFixed(3))).size).toBeGreaterThan(5);
  expect(Math.min(...a)).toBeGreaterThanOrEqual(0.6);
  expect(Math.max(...a)).toBeLessThan(1.4);
});
