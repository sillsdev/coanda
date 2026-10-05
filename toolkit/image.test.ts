import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { ffmpeg, imageSize } from "./ffmpeg.ts";
import { DEFAULT_IMAGE_MODEL, image, withRoster } from "./image.ts";
import { estimateInputImageTokens, estimateOutputImageTokens } from "./imageCost.ts";
import { snapToOpenAiImageSize } from "./imageSizes.ts";

const realFetch = globalThis.fetch;
const realKey = process.env.OPENROUTER_API_KEY;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = realKey;
});

interface ImagesBody {
  model: string;
  prompt: string;
  aspect_ratio: string;
  size?: string;
  input_references?: { image_url: { url: string } }[];
}

/** Stands in for OpenRouter's images API: records each request and answers with `png`. */
function fakeOpenRouter(png: Buffer, emptyFirst = 0) {
  const requests: { url: string; headers: Record<string, string>; body: ImagesBody }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as ImagesBody,
    });
    const data =
      requests.length <= emptyFirst
        ? []
        : [{ b64_json: png.toString("base64"), media_type: "image/png" }];
    return new Response(JSON.stringify({ data, usage: { cost: 0.0412 } }), { status: 200 });
  }) as typeof fetch;
  return requests;
}

/** A real PNG of the given size, made with ffmpeg. */
function png(file: string, width: number, height: number) {
  ffmpeg(["-f", "lavfi", "-i", `color=c=orange:s=${width}x${height}`, "-frames:v", "1", file]);
  return file;
}

test("an edit goes to the images API, with the image to edit first and named in the prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "howbench-image-"));
  process.env.OPENROUTER_API_KEY = "test-key";
  const cover = png(join(dir, "cover.png"), 3000, 1500);
  const butterfly = png(join(dir, "butterfly.png"), 1600, 1600);
  const requests = fakeOpenRouter(Buffer.from("made image"));

  const made = await image({
    out: join(dir, "cover-es.png"),
    prompt: "Put the title in Spanish",
    inputs: [cover, butterfly],
  });

  expect(readFileSync(join(dir, "cover-es.png"), "utf8")).toBe("made image");
  expect(made).toMatchObject({ model: DEFAULT_IMAGE_MODEL, cost: 0.0412, size: null });
  const [request] = requests;
  expect(request.url).toBe("https://openrouter.ai/api/v1/images");
  expect(request.headers.Authorization).toBe("Bearer test-key");
  expect(request.body).toMatchObject({
    model: "openai/gpt-image-2.5-sunburst",
    aspect_ratio: "auto",
    prompt:
      "Input images, in order:\n1. the image to edit\n2. a reference image\n\nPut the title in Spanish",
  });
  // The image to edit is sent at up to 2048px, a reference at up to 1024px.
  const sent = request.body.input_references!.map((r) => {
    const file = join(dir, `sent-${Math.random()}.png`);
    writeFileSync(file, Buffer.from(r.image_url.url.split(",")[1], "base64"));
    return imageSize(file);
  });
  expect(sent).toEqual([
    { width: 2048, height: 1024 },
    { width: 1024, height: 1024 },
  ]);
});

test("a size is snapped to what the model accepts, and sent without an aspect ratio", async () => {
  const dir = mkdtempSync(join(tmpdir(), "howbench-image-"));
  process.env.OPENROUTER_API_KEY = "test-key";
  const requests = fakeOpenRouter(Buffer.from("x"));
  const made = await image({ out: join(dir, "a.png"), prompt: "Monarchs", size: "1500x1001" });
  expect(requests[0].body).toMatchObject({ size: "1504x1008", aspect_ratio: "auto" });
  expect(requests[0].body.input_references).toBeUndefined();
  expect(made.size).toBe("1504x1008");
});

test("a response with no image is asked for again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "howbench-image-"));
  process.env.OPENROUTER_API_KEY = "test-key";
  const requests = fakeOpenRouter(Buffer.from("x"), 2);
  await image({ out: join(dir, "a.png"), prompt: "Monarchs", aspect: "16:9" });
  expect(requests).toHaveLength(3);
  expect(requests[0].body.aspect_ratio).toBe("16:9");
});

test("an estimate costs nothing and calls nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "howbench-image-"));
  const requests = fakeOpenRouter(Buffer.from("x"));
  const made = await image({ out: join(dir, "a.png"), prompt: "Monarchs", estimate: true });
  expect(requests).toHaveLength(0);
  expect(made.out).toBeNull();
  // 150 prompt tokens at $5/M and a 1024x1024 image (196 tokens) at $30/M.
  expect(made.estimatedCost).toBeCloseTo(0.00663, 5);
});

test("the project's recipe can choose another model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "howbench-image-"));
  process.env.OPENROUTER_API_KEY = "test-key";
  writeFileSync(
    join(dir, "video-project.json"),
    JSON.stringify({ images: { model: "openai/gpt-image-2.5-flare" } }),
  );
  const requests = fakeOpenRouter(Buffer.from("x"));
  await image({ out: join(dir, "a.png"), prompt: "A butterfly" });
  expect(requests[0].body.model).toBe("openai/gpt-image-2.5-flare");
});

test("without inputs the prompt goes as written", () => {
  expect(withRoster("A butterfly", 0, 0)).toBe("A butterfly");
});

// Sizes and costs measured against OpenRouter by the Bloom AI image tools.

test("sizes follow GPT Image 2.5's rules", () => {
  expect(snapToOpenAiImageSize({ width: 1536, height: 1024 })).toEqual({
    width: 1536,
    height: 1024,
  });
  expect(snapToOpenAiImageSize({ width: 1500, height: 1001 })).toEqual({
    width: 1504,
    height: 1008,
  });
  const wide = snapToOpenAiImageSize({ width: 4000, height: 500 });
  expect(wide.width / wide.height).toBeLessThanOrEqual(3);
  expect((wide.width % 16) + (wide.height % 16)).toBe(0);
  expect(snapToOpenAiImageSize(null)).toEqual({ width: 1024, height: 1024 });
});

test("input images cost by 32px patches, with a floor and a ceiling", () => {
  expect(estimateInputImageTokens({ width: 1024, height: 479 })).toBe(490);
  expect(estimateInputImageTokens({ width: 1536, height: 718 })).toBe(1114);
  expect(estimateInputImageTokens({ width: 768, height: 359 })).toBe(490);
  expect(estimateInputImageTokens({ width: 256, height: 120 })).toBe(138);
  expect(estimateInputImageTokens({ width: 4096, height: 1916 })).toBe(1466);
  expect(estimateInputImageTokens({ width: 2048, height: 2048 })).toBe(1531);
});

test("output images cost what was measured for their size", () => {
  expect(estimateOutputImageTokens({ width: 1232, height: 544 })).toBe(75);
  expect(estimateOutputImageTokens({ width: 1024, height: 1536 })).toBe(158);
  expect(estimateOutputImageTokens({ width: 3072, height: 2048 })).toBe(365);
});
