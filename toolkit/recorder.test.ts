import { expect, test } from "vite-plus/test";
import { glideMs } from "./recorder.ts";

test("a pointer move takes 400 ms plus 0.7 ms per pixel, at most 1.1 s", () => {
  expect(glideMs(0)).toBe(400);
  expect(glideMs(500)).toBe(750);
  expect(glideMs(1000)).toBe(1100);
  expect(glideMs(3000)).toBe(1100);
});
