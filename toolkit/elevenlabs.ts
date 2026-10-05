// Recording a narration line with ElevenLabs.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Alignment } from "./voiceCache.ts";

/** The API key: from the environment, or the one saved in HowBench's settings. */
export function elevenLabsKey(): string | undefined {
  const fromEnv = process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_KEY;
  if (fromEnv) return fromEnv;
  const file = join(homedir(), ".howbench", "elevenlabs_key.txt");
  return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
}

/**
 * Says one line. The lines before and after it are sent as context, so the line is spoken as
 * part of the narration around it; they aren't spoken.
 */
export async function speak(opts: {
  apiKey: string;
  voiceId: string;
  model: string;
  text: string;
  previous: string;
  next: string;
}): Promise<{ audio: Buffer; alignment: Alignment }> {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}/with-timestamps`,
    {
      method: "POST",
      headers: { "xi-api-key": opts.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: opts.text,
        model_id: opts.model,
        previous_text: opts.previous || undefined,
        next_text: opts.next || undefined,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `ElevenLabs refused "${opts.text}": ${response.status} ${await response.text()}`,
    );
  }
  const reply = (await response.json()) as { audio_base64: string; alignment: Alignment };
  return { audio: Buffer.from(reply.audio_base64, "base64"), alignment: reply.alignment };
}
