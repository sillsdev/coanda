// `howreel image`: makes a new image from a description, or edits images, through OpenRouter.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { convertImage, imageSize } from "./ffmpeg.ts";
import { estimateImageCostUsd, REFERENCE_LONG_EDGE } from "./imageCost.ts";
import {
  formatPixelSize,
  parseAspectRatio,
  parsePixelSize,
  snapToOpenAiImageSize,
  SUPPORTED_ASPECT_RATIOS,
  type PixelSize,
} from "./imageSizes.ts";
import { generateImage, openRouterKey } from "./openrouter.ts";
import { findRecipe } from "./recipe.ts";

/** OpenAI's most capable model for making and editing images, as OpenRouter names it. */
export const DEFAULT_IMAGE_MODEL = "openai/gpt-image-2.5-sunburst";

/** The most input images GPT Image 2.5 takes in one request, the image to edit included. */
const MAX_INPUT_IMAGES = 16;

/** Beyond this long edge, the provider shrinks an input image anyway: more costs nothing and
 * gains nothing. */
const EDIT_LONG_EDGE = 2048;

/** The `images` entry of a project's video-project.json. */
export interface ImageSettings {
  model?: string;
}

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export interface ImageOptions {
  out: string;
  prompt: string;
  /** Input images. Unless `fromReferences`, the first is the image to edit and any others
   * are references. */
  inputs?: string[];
  /** All the inputs are references for a new image; none is edited. */
  fromReferences?: boolean;
  /** An aspect ratio such as "16:9", from SUPPORTED_ASPECT_RATIOS. */
  aspect?: string;
  /** Exact pixels such as "1536x1024", brought to the nearest size the model accepts. */
  size?: string;
  /** "auto", "low", "medium", "high", "xhigh" or "max". */
  quality?: string;
  model?: string;
  /** Only estimate the cost; make nothing. */
  estimate?: boolean;
}

export interface ImageResult {
  out: string | null;
  model: string;
  /** The output size asked for, or null when the model chooses. */
  size: string | null;
  /** GPT Image 2.5's prices, in US dollars; null for another model, whose prices HowReel
   * doesn't know. */
  estimatedCost: number | null;
  /** What OpenRouter charged, in US dollars; null for an estimate, or when it didn't say. */
  cost: number | null;
}

/**
 * Makes an image from `prompt` and writes it to `out`. With inputs, the model edits the first
 * and works from the others, or with `fromReferences` makes a new image from them all.
 */
export async function image(opts: ImageOptions): Promise<ImageResult> {
  const out = resolve(opts.out);
  const settings = findRecipe(dirname(out)).recipe.images as ImageSettings | undefined;
  const model = opts.model ?? settings?.model ?? DEFAULT_IMAGE_MODEL;
  const inputs = (opts.inputs ?? []).map((i) => resolve(i));
  if (inputs.length > MAX_INPUT_IMAGES) {
    throw new Error(
      `The model takes at most ${MAX_INPUT_IMAGES} input images; this has ${inputs.length}`,
    );
  }
  const editCount = inputs.length && !opts.fromReferences ? 1 : 0;

  // The output: exact pixels, or an aspect ratio, or the shape of the image being edited.
  if (opts.aspect && !SUPPORTED_ASPECT_RATIOS.includes(opts.aspect)) {
    throw new Error(`The aspect ratio must be one of ${SUPPORTED_ASPECT_RATIOS.join(", ")}`);
  }
  const askedSize = parsePixelSize(opts.size);
  if (opts.size && !askedSize) throw new Error(`The size must be like 1536x1024: ${opts.size}`);
  const size = askedSize ? snapToOpenAiImageSize(askedSize) : null;

  const work = mkdtempSync(join(tmpdir(), "howreel-image-"));
  try {
    // References go at most 1024px on their long edge, where they cost least for what they show;
    // an image being edited keeps its detail up to where more would cost nothing.
    const prepared = inputs.map((input, i) => {
      const limit = i < editCount ? EDIT_LONG_EDGE : REFERENCE_LONG_EDGE;
      const original = imageSize(input);
      const ext = extname(input).toLowerCase();
      if (Math.max(original.width, original.height) <= limit && MEDIA_TYPES[ext]) {
        return { file: input, type: MEDIA_TYPES[ext], size: original };
      }
      const scaled = join(work, `input-${i}.png`);
      convertImage(input, scaled, limit);
      return { file: scaled, type: "image/png", size: imageSize(scaled) };
    });

    const outputGuess: PixelSize | null =
      size ?? (opts.aspect ? fromAspect(opts.aspect) : editCount ? prepared[0].size : null);
    const estimatedCost =
      model === DEFAULT_IMAGE_MODEL
        ? estimateImageCostUsd(
            prepared.map((p) => p.size),
            outputGuess,
            { editingDetail: editCount > 0 },
          )
        : null;
    const result = { model, size: size ? formatPixelSize(size) : null, estimatedCost };
    if (opts.estimate) return { ...result, out: null, cost: null };

    const key = openRouterKey();
    if (!key) throw new Error("No OpenRouter key: set one in HowReel's settings");
    // Before paying for the image, so there's somewhere to save it.
    mkdirSync(dirname(out), { recursive: true });
    const made = await generateImage(key, {
      model,
      prompt: withRoster(opts.prompt, prepared.length, editCount),
      aspectRatio: opts.aspect ?? "auto",
      ...(size ? { size: formatPixelSize(size) } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
      inputs: prepared.map(
        (p) => `data:${p.type};base64,${readFileSync(p.file).toString("base64")}`,
      ),
    });

    // Written in the format `out` names, converting if the model sent another.
    const madeExt = Object.entries(MEDIA_TYPES).find(([, type]) => type === made.mediaType)?.[0];
    const outType = MEDIA_TYPES[extname(out).toLowerCase()];
    if (!outType || outType === made.mediaType) {
      writeFileSync(out, made.image);
    } else {
      const raw = join(work, `made${madeExt ?? ".png"}`);
      writeFileSync(raw, made.image);
      convertImage(raw, out);
    }
    return { ...result, out, model: made.model, cost: made.cost };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A 1024px image of an aspect ratio, as the model would make by default for it. */
function fromAspect(aspect: string): PixelSize | null {
  const ratio = parseAspectRatio(aspect);
  if (!ratio) return null;
  const scale = 1024 / Math.max(ratio.width, ratio.height);
  return snapToOpenAiImageSize({ width: ratio.width * scale, height: ratio.height * scale });
}

/**
 * The prompt, with a numbered list of the input images at its head, saying which one is to be
 * edited. The images API has nowhere to label an image, so this is how the model knows, and
 * OpenAI's image prompting guide asks for exactly this.
 */
export function withRoster(prompt: string, imageCount: number, editCount: number): string {
  if (!imageCount) return prompt;
  const lines = Array.from(
    { length: imageCount },
    (_, i) => `${i + 1}. ${i < editCount ? "the image to edit" : "a reference image"}`,
  );
  return `Input images, in order:\n${lines.join("\n")}\n\n${prompt}`;
}
