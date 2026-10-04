// What a GPT Image 2.5 call will cost, from the pixels sent and the pixels asked for. The rules
// and figures were measured against OpenRouter by the Bloom AI image tools (their
// MODEL-COSTS.md and lib/imageCostEstimate.ts, 2026-09-14), which this follows. An image the
// model is shown costs far more than the image it draws: a 1024px reference is 490 tokens; the
// picture it helps draw is 75 to 365.
import type { PixelSize } from "./imageSizes.ts";

/** GPT Image 2.5's published rates, confirmed to the cent in those measurements. */
export const GPT_IMAGE_25_PRICING = {
  textInputUsdPerMillion: 5,
  imageInputUsdPerMillion: 8,
  outputUsdPerMillion: 30,
};

/** The vision encoder bills one token per patch this many pixels square, plus an overhead. */
const PATCH_EDGE = 32;
const TOKEN_OVERHEAD = 10;
/** Above this many patches the provider shrinks the image before counting. */
const MAX_PATCHES = 1536;
/** Below this long edge the charge stops falling: the image is scaled up, by at most 2x. */
const FLOOR_LONG_EDGE = 1024;
const FLOOR_MAX_SCALE = 2;
/** Tokens a typical prompt's text costs; a long one is a few hundred more, which hardly counts. */
const PROMPT_TEXT_TOKENS = 150;
/** The output size to assume when none is asked for: the model's default. */
const DEFAULT_OUTPUT: PixelSize = { width: 1024, height: 1024 };

/** The longest edge worth sending for a reference image: below it, detail goes for nothing
 * saved, because small references are billed as if this size. */
export const REFERENCE_LONG_EDGE = 1024;

function patchesFor(size: PixelSize): { wide: number; high: number } {
  let width = Math.max(1, size.width);
  let height = Math.max(1, size.height);
  const longEdge = Math.max(width, height);
  if (longEdge < FLOOR_LONG_EDGE) {
    const scale = Math.min(FLOOR_MAX_SCALE, FLOOR_LONG_EDGE / longEdge);
    width *= scale;
    height *= scale;
  }
  let wide = width / PATCH_EDGE;
  let high = height / PATCH_EDGE;
  if (wide * high > MAX_PATCHES) {
    const shrink = Math.sqrt(MAX_PATCHES / (wide * high));
    wide *= shrink;
    high *= shrink;
    const settle = Math.min(Math.floor(wide) / wide, Math.floor(high) / high);
    wide *= settle;
    high *= settle;
  }
  return { wide: Math.ceil(wide), high: Math.ceil(high) };
}

/** Tokens one input image bills. */
export function estimateInputImageTokens(size: PixelSize): number {
  if (!(size.width > 0 && size.height > 0)) return estimateInputImageTokens(DEFAULT_OUTPUT);
  const { wide, high } = patchesFor(size);
  return wide * high + TOKEN_OVERHEAD;
}

/** Output tokens measured per requested size, with no reference. The same request sometimes
 * bills more, so an estimate from this can be under by about half a cent. */
const OUTPUT_TOKENS_BY_SIZE: { size: PixelSize; tokens: number }[] = [
  { size: { width: 1232, height: 544 }, tokens: 75 },
  { size: { width: 1024, height: 1024 }, tokens: 196 },
  { size: { width: 1536, height: 1024 }, tokens: 158 },
  { size: { width: 2048, height: 1536 }, tokens: 247 },
  { size: { width: 3072, height: 2048 }, tokens: 365 },
];

/**
 * Output tokens for a picture redrawn in full, such as an edit of a detailed image: it bills
 * for its detail, not its pixels (a 1024x1024 restoration billed 1756).
 */
export const DETAILED_EDIT_OUTPUT_TOKENS = 1800;

/** Output tokens for a requested size: the measured figure, or a straight line between the
 * nearest two by pixel count, held flat beyond the ends. */
export function estimateOutputImageTokens(size: PixelSize): number {
  const exact = OUTPUT_TOKENS_BY_SIZE.find(
    (e) =>
      (e.size.width === size.width && e.size.height === size.height) ||
      (e.size.width === size.height && e.size.height === size.width),
  );
  if (exact) return exact.tokens;
  const table = OUTPUT_TOKENS_BY_SIZE.map((e) => ({
    pixels: e.size.width * e.size.height,
    tokens: e.tokens,
  })).sort((a, b) => a.pixels - b.pixels);
  const pixels = Math.max(1, size.width * size.height);
  if (pixels <= table[0].pixels) return table[0].tokens;
  for (let i = 1; i < table.length; i += 1) {
    if (pixels <= table[i].pixels) {
      const t = (pixels - table[i - 1].pixels) / (table[i].pixels - table[i - 1].pixels);
      return Math.round(table[i - 1].tokens + t * (table[i].tokens - table[i - 1].tokens));
    }
  }
  return table[table.length - 1].tokens;
}

/** The estimated cost of one call, in US dollars. */
export function estimateImageCostUsd(
  inputImages: PixelSize[],
  outputSize: PixelSize | null,
  options: { editingDetail?: boolean } = {},
): number {
  const p = GPT_IMAGE_25_PRICING;
  const inputTokens = inputImages.reduce((n, size) => n + estimateInputImageTokens(size), 0);
  const outputTokens = Math.max(
    estimateOutputImageTokens(outputSize ?? DEFAULT_OUTPUT),
    options.editingDetail ? DETAILED_EDIT_OUTPUT_TOKENS : 0,
  );
  return (
    (inputTokens * p.imageInputUsdPerMillion +
      PROMPT_TEXT_TOKENS * p.textInputUsdPerMillion +
      outputTokens * p.outputUsdPerMillion) /
    1e6
  );
}
