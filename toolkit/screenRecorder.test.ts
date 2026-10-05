import { expect, test } from "vite-plus/test";
import { captureArea, ddagrabArgs, glide, parseStart } from "./screenRecorder.ts";
import type { Output } from "./windows/windows.ts";

const screens: Output[] = [
  { index: 0, device: "\\.DISPLAY2", rotation: 1, box: { x: 0, y: 0, width: 3840, height: 2160 } },
  {
    index: 1,
    device: "\\.DISPLAY1",
    rotation: 1,
    box: { x: 3840, y: 432, width: 1920, height: 1200 },
  },
];

test("the capture area is on the screen that holds the rectangle, relative to it, with even sides", () => {
  expect(captureArea({ x: 4000, y: 500, width: 625, height: 361 }, screens)).toEqual({
    output: 1,
    offsetX: 160,
    offsetY: 68,
    width: 624,
    height: 360,
    x: 4000,
    y: 500,
  });
  expect(captureArea({ x: 0, y: 0, width: 3840, height: 2160 }, screens).output).toBe(0);
});

test("a rectangle across two screens, or off them, is refused", () => {
  expect(() => captureArea({ x: 3700, y: 500, width: 400, height: 300 }, screens)).toThrow(
    /not all on one screen/,
  );
  expect(() => captureArea({ x: -10, y: 0, width: 100, height: 100 }, screens)).toThrow();
});

test("ffmpeg films the area with ddagrab, stamping frames with the wall clock", () => {
  const args = ddagrabArgs(
    { output: 1, offsetX: 160, offsetY: 68, width: 624, height: 360, x: 4000, y: 500 },
    "take/capture.mkv",
  );
  expect(args).toContain(
    "ddagrab=output_idx=1:draw_mouse=0:framerate=30:offset_x=160:offset_y=68:video_size=624x360",
  );
  expect(
    args.slice(
      args.indexOf("-use_wallclock_as_timestamps"),
      args.indexOf("-use_wallclock_as_timestamps") + 2,
    ),
  ).toEqual(["-use_wallclock_as_timestamps", "1"]);
  expect(args.at(-1)).toBe("take/capture.mkv");
  expect(
    ddagrabArgs({ output: 0, offsetX: 0, offsetY: 0, width: 2, height: 2, x: 0, y: 0 }, "f", {
      drawMouse: true,
    }).join(" "),
  ).toContain("draw_mouse=1");
});

test("the first frame's time comes from ffmpeg's report on its input", () => {
  const report = `Input #0, lavfi, from 'ddagrab=output_idx=0':\n  Duration: N/A, start: 1759561234.123456, bitrate: N/A\n`;
  expect(parseStart(report)).toBe(1759561234.123456);
  expect(parseStart("Input #0, lavfi, from 'ddagrab'")).toBeUndefined();
  expect(parseStart("Duration: N/A, start: 0.000000, bitrate: N/A")).toBeUndefined();
});

test("a glide ends where it is going, at the time it should, a point every 1/30 s", () => {
  const path = glide({ x: 0, y: 0 }, { x: 300, y: 150 }, 2, 0.9);
  expect(path).toHaveLength(27);
  expect(path.at(-1)).toEqual({ t: 2.9, x: 300, y: 150 });
  expect(path[0].t).toBeCloseTo(2.033, 3);
  expect(path.every((p, i) => i === 0 || p.x >= path[i - 1].x)).toBe(true);
});
