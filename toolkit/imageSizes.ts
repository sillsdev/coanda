// The output sizes GPT Image 2.5 accepts. These rules come from OpenAI's image prompting guide
// and were each confirmed against OpenRouter by the Bloom AI image tools
// (bloom-ai-image-tools/lib/imageSizes.ts, which this follows); every one is a hard 400.

export interface PixelSize {
  width: number;
  height: number;
}

/** The aspect ratios OpenRouter's images API takes for GPT Image 2.5, besides "auto". */
export const SUPPORTED_ASPECT_RATIOS = ["2:3", "3:4", "9:16", "1:1", "4:3", "3:2", "16:9", "21:9"];

export const OPENAI_IMAGE_SIZE_CONSTRAINTS = {
  maxEdge: 3840,
  edgeMultiple: 16,
  maxEdgeRatio: 3,
  minPixels: 655360,
  maxPixels: 8294400,
} as const;

const roundToMultiple = (value: number, multiple: number): number =>
  Math.max(multiple, Math.round(value / multiple) * multiple);

/**
 * The nearest size GPT Image 2.5 will accept to the one asked for, keeping the shape as close
 * as the rules allow. A size that can't be read falls back to the model's own 1024x1024.
 */
export function snapToOpenAiImageSize(desired: PixelSize | null | undefined): PixelSize {
  const { maxEdge, edgeMultiple, maxEdgeRatio, minPixels, maxPixels } =
    OPENAI_IMAGE_SIZE_CONSTRAINTS;

  let width = desired?.width ?? 0;
  let height = desired?.height ?? 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    width = 1024;
    height = 1024;
  }

  // Bring the shape inside 3:1 by pulling the long edge in; pushing the short edge out would
  // inflate the pixel count of a panorama.
  if (width / height > maxEdgeRatio) width = height * maxEdgeRatio;
  if (height / width > maxEdgeRatio) height = width * maxEdgeRatio;

  // Scale into the pixel budget and under the edge cap, keeping the shape.
  const pixels = width * height;
  const budgetScale =
    pixels < minPixels
      ? Math.sqrt(minPixels / pixels)
      : pixels > maxPixels
        ? Math.sqrt(maxPixels / pixels)
        : 1;
  width *= budgetScale;
  height *= budgetScale;

  const edgeScale = Math.min(1, maxEdge / Math.max(width, height));
  width *= edgeScale;
  height *= edgeScale;

  width = Math.min(maxEdge, roundToMultiple(width, edgeMultiple));
  height = Math.min(maxEdge, roundToMultiple(height, edgeMultiple));

  // Rounding to the grid can push a rule back out (1500x500 rounds to 1504x496, past 3:1), so
  // settle each rule on the grid itself, a whole multiple at a time.
  const steps = maxEdge / edgeMultiple;
  for (
    let i = 0;
    i < steps &&
    Math.max(width, height) / Math.min(width, height) > maxEdgeRatio &&
    Math.max(width, height) > edgeMultiple;
    i += 1
  ) {
    if (width >= height) width -= edgeMultiple;
    else height -= edgeMultiple;
  }
  for (let i = 0; i < steps && width * height > maxPixels; i += 1) {
    if (width >= height) width -= edgeMultiple;
    else height -= edgeMultiple;
  }
  for (let i = 0; i < steps && width * height < minPixels; i += 1) {
    if (width <= height && width + edgeMultiple <= maxEdge) width += edgeMultiple;
    else if (height + edgeMultiple <= maxEdge) height += edgeMultiple;
    else break;
  }

  return { width, height };
}

/** A size as the `size` parameter spells it, such as "1536x1024". */
export const formatPixelSize = (size: PixelSize): string => `${size.width}x${size.height}`;

/** "1536x1024" as a size, or null. */
export function parsePixelSize(value: string | null | undefined): PixelSize | null {
  const match = value?.trim().match(/^(\d+)x(\d+)$/i);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

/** The two numbers in an aspect ratio like "16:9", or null for "auto" and anything else. */
export function parseAspectRatio(value: string | null | undefined): PixelSize | null {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}
