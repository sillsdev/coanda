"""Says narration lines with Kokoro, a free voice that runs on this computer, for HowReel's voice
pass (toolkit/kokoro.ts runs it).

Reads a request as JSON on stdin:
  {"voice": "af_heart", "langCode": "a", "speed": 1.0,
   "lines": [{"spoken": "Click it.", "seed": 12345, "out": "C:/tmp/line.wav"}, ...]}
`voice` may be a blend, such as "af_heart,bf_emma". `spoken` may hold Kokoro's markup:
[word](+1) or [word](-1) moves the stress, [word](/phonemes/) sets the sound.

Writes each line as a 24 kHz mono WAV at `out`, levelled to the same loudness, and prints one
JSON object per line as it is finished:
  {"out": ..., "seconds": <when the speech ends>, "duration": ..., "words": [{"text", "start", "end"}]}

Exits with 2 for a bad request and 3, saying how to install it, when Kokoro is missing.
"""
import json
import math
import re
import struct
import sys
import wave

SAMPLE_RATE = 24000
# Kokoro is given one sentence at a time, with this much silence between them.
SENTENCE_PAUSE = 0.18
# Every line is brought to this loudness (RMS, full scale = 1).
TARGET_RMS = 0.08
BAD_REQUEST = 2
MISSING = 3

INSTALL_WINDOWS = """  py -3.12 -m venv C:\\tts\\kokoro-env
  C:\\tts\\kokoro-env\\Scripts\\pip install kokoro
then set "python": "C:\\\\tts\\\\kokoro-env\\\\Scripts\\\\python.exe" in the recipe's voice entry."""
INSTALL_OTHER = """  python3.12 -m venv ~/tts/kokoro-env
  ~/tts/kokoro-env/bin/pip install kokoro
then set "python" to the full path of ~/tts/kokoro-env/bin/python in the recipe's voice entry."""
INSTALL = """Kokoro isn't installed for {python}.
Install it in its own Python environment (about 2 GB with torch; the voice model, about 0.3 GB,
downloads the first time it speaks):
{steps}
Languages other than English also need espeak-ng (https://github.com/espeak-ng/espeak-ng).
({error})"""


def read_request(text):
    """The request, checked; raises ValueError saying what's wrong."""
    try:
        request = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"the request isn't JSON: {e}")
    if not isinstance(request, dict):
        raise ValueError("the request must be a JSON object")
    voice = request.get("voice")
    if not isinstance(voice, str) or not voice.strip():
        raise ValueError('the request needs "voice", such as "af_heart"')
    lang = request.get("langCode") or voice.strip()[0]
    speed = request.get("speed", 1.0)
    if not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2.0:
        raise ValueError('"speed" must be a number from 0.5 to 2')
    lines = request.get("lines")
    if not isinstance(lines, list) or not lines:
        raise ValueError('the request needs "lines", a list of lines to say')
    for i, line in enumerate(lines):
        if not isinstance(line, dict) or not isinstance(line.get("spoken"), str) or not line["spoken"].strip():
            raise ValueError(f'line {i + 1} needs "spoken", the words to say')
        if not isinstance(line.get("out"), str) or not line["out"]:
            raise ValueError(f'line {i + 1} needs "out", the WAV file to write')
        if not isinstance(line.get("seed", 0), int):
            raise ValueError(f'line {i + 1}: "seed" must be a whole number')
    return {"voice": voice.strip(), "langCode": lang, "speed": float(speed), "lines": lines}


def sentences(text):
    """The line split after each sentence's final punctuation."""
    return [s for s in re.split(r"(?<=[.!?:])\s+", text.strip()) if s.strip()]


def floats(audio):
    """Kokoro's audio (a torch tensor) as a list of floats."""
    if hasattr(audio, "detach"):
        audio = audio.detach().cpu()
    if hasattr(audio, "tolist"):
        audio = audio.tolist()
    return [float(x) for x in audio]


def say(pipe, voice, speed, text, seed, torch):
    """The line's samples, and each word's start and end where Kokoro gives them."""
    # Kokoro adds random noise; a fixed seed per line keeps a line the same each time.
    torch.manual_seed(seed)
    samples = []
    words = []
    parts = sentences(text)
    for i, part in enumerate(parts):
        for result in pipe(part, voice=voice, speed=speed):
            audio = result[2] if isinstance(result, tuple) else getattr(result, "audio", None)
            if audio is None:
                continue
            offset = len(samples) / SAMPLE_RATE
            for token in getattr(result, "tokens", None) or []:
                start, end = getattr(token, "start_ts", None), getattr(token, "end_ts", None)
                if start is not None and end is not None:
                    words.append({"text": token.text, "start": round(offset + start, 3), "end": round(offset + end, 3)})
            samples.extend(floats(audio))
        if i < len(parts) - 1:
            samples.extend([0.0] * int(SENTENCE_PAUSE * SAMPLE_RATE))
    return samples, words


def level(samples):
    """The samples brought to TARGET_RMS, and down further if that would clip."""
    if not samples:
        return samples
    rms = math.sqrt(sum(x * x for x in samples) / len(samples)) or 1.0
    gain = TARGET_RMS / rms
    peak = max(abs(x) for x in samples) * gain
    if peak > 0.97:
        gain *= 0.97 / peak
    return [x * gain for x in samples]


def speech_end(samples):
    """When the speech ends, in seconds: the last sample louder than 2% of the peak."""
    peak = max((abs(x) for x in samples), default=0.0)
    for i in range(len(samples) - 1, -1, -1):
        if abs(samples[i]) > peak * 0.02:
            return round(min(len(samples), i + 1 + int(0.05 * SAMPLE_RATE)) / SAMPLE_RATE, 3)
    return 0.0


def write_wav(path, samples):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, round(x * 32767)))) for x in samples))


def load_kokoro():
    try:
        import torch
        from kokoro import KPipeline
    except ImportError as e:
        steps = INSTALL_WINDOWS if sys.platform == "win32" else INSTALL_OTHER
        sys.stderr.write(INSTALL.format(python=sys.executable, steps=steps, error=e) + "\n")
        sys.exit(MISSING)
    return torch, KPipeline


def main():
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        request = read_request(sys.stdin.read())
    except ValueError as e:
        sys.stderr.write(f"kokoro_say.py: {e}\n")
        sys.exit(BAD_REQUEST)
    torch, KPipeline = load_kokoro()
    pipe = KPipeline(lang_code=request["langCode"])
    for line in request["lines"]:
        samples, words = say(pipe, request["voice"], request["speed"], line["spoken"], line.get("seed", 0), torch)
        samples = level(samples)
        write_wav(line["out"], samples)
        print(json.dumps({
            "out": line["out"],
            "seconds": speech_end(samples),
            "duration": round(len(samples) / SAMPLE_RATE, 3),
            "words": words,
        }), flush=True)


if __name__ == "__main__":
    main()
