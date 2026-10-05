// Talking to OpenRouter: the key, its images API, its errors, and the account's credits. How
// the images API behaves follows what the Bloom AI image tools found against it
// (bloom-ai-image-tools/services/openRouterService.ts).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_URL = "https://openrouter.ai/api/v1";
const CREDITS_PAGE = "https://openrouter.ai/settings/credits";

/** The API key: from the environment, or the one saved in HowBench's settings. */
export function openRouterKey(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const file = join(homedir(), ".howbench", "openrouter_key.txt");
  return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
}

function headers(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "X-Title": "HowBench",
  };
}

/** What OpenRouter said went wrong, from the places it puts it. */
function detailOf(data: unknown): string | undefined {
  const d = data as {
    error?: { message?: unknown; metadata?: { raw?: unknown } };
    message?: unknown;
  };
  for (const value of [d?.error?.metadata?.raw, d?.error?.message, d?.message]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** A failed response as an error that says what to do about it. */
function failure(status: number, data: unknown, rawText: string, model: string): Error {
  const detail = detailOf(data);
  if (status === 402) {
    return new Error(
      `The OpenRouter account is out of credits (${detail ?? "402"}). Add credits at ${CREDITS_PAGE}.`,
    );
  }
  if (status === 429) {
    return new Error(`OpenRouter's servers for ${model} are busy just now; try again shortly.`);
  }
  const message = detail || rawText || String(status);
  return new Error(`OpenRouter refused the request: ${status} ${message.slice(0, 500)}`);
}

async function readJson(response: Response): Promise<{ data: unknown; rawText: string }> {
  const rawText = await response.text();
  try {
    return { data: rawText ? JSON.parse(rawText) : null, rawText };
  } catch {
    return { data: null, rawText };
  }
}

export interface ImagesRequest {
  model: string;
  prompt: string;
  /** "auto" follows the input image's shape, or the model's default with none. */
  aspectRatio: string;
  /** Exact pixels, such as "1536x1024". With a size, the aspect ratio must be "auto". */
  size?: string;
  quality?: string;
  /** Input images as data URLs, the image to edit first. */
  inputs: string[];
}

export interface ImagesResult {
  /** The image, and its media type. */
  image: Buffer;
  mediaType: string;
  model: string;
  /** What OpenRouter charged, in US dollars, when it says. */
  cost: number | null;
}

/** A response with no image in it is resent this many times before giving up. */
const MAX_ATTEMPTS = 3;

/**
 * Makes or edits an image through OpenRouter's images API (POST /api/v1/images). Dedicated
 * image models such as GPT Image 2.5 are served only there: chat/completions answers them
 * with a 404. It takes a prompt, the input images as `input_references`, and an aspect ratio
 * or a pixel size, and answers with the image as base64.
 */
export async function generateImage(key: string, request: ImagesRequest): Promise<ImagesResult> {
  const body = {
    model: request.model,
    prompt: request.prompt,
    n: 1,
    aspect_ratio: request.size ? "auto" : request.aspectRatio,
    ...(request.size ? { size: request.size } : {}),
    ...(request.quality ? { quality: request.quality } : {}),
    ...(request.inputs.length
      ? {
          input_references: request.inputs.map((url) => ({
            type: "image_url",
            image_url: { url },
          })),
        }
      : {}),
  };
  let lastDetail = "an empty data array";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${BASE_URL}/images`, {
      method: "POST",
      headers: headers(key),
      body: JSON.stringify(body),
    });
    const { data, rawText } = await readJson(response);
    if (!response.ok) throw failure(response.status, data, rawText, request.model);
    const reply = data as {
      model?: string;
      data?: { b64_json?: string; media_type?: string }[];
      usage?: { cost?: number };
    };
    const first = reply?.data?.find((d) => typeof d?.b64_json === "string" && d.b64_json);
    if (first?.b64_json) {
      return {
        image: Buffer.from(first.b64_json, "base64"),
        mediaType: first.media_type?.startsWith("image/") ? first.media_type : "image/png",
        model: reply.model ?? request.model,
        cost: typeof reply.usage?.cost === "number" ? reply.usage.cost : null,
      };
    }
    lastDetail = detailOf(data) ?? (rawText.slice(0, 300) || lastDetail);
  }
  throw new Error(`OpenRouter did not return an image. It answered: ${lastDetail}`);
}

/** The account's credit: what's been bought, what's been used, and what's left, in dollars. */
export async function credits(
  key: string,
): Promise<{ total: number; used: number; remaining: number }> {
  const response = await fetch(`${BASE_URL}/credits`, { headers: headers(key) });
  const { data, rawText } = await readJson(response);
  if (!response.ok) throw failure(response.status, data, rawText, "credits");
  const d = (data as { data?: { total_credits?: unknown; total_usage?: unknown } })?.data;
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const total = num(d?.total_credits);
  const used = num(d?.total_usage);
  return { total, used, remaining: Math.max(0, total - used) };
}
