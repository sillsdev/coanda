# What the first video agent taught us

Source material for Coanda's guidance to video agents. On 2026-10-03 the Coanda dev session
asked the Claude session revising "Using the Basic Book Template" (in bloom-training-videos)
what Coanda should tell every video agent. These are its answers, verbatim. The guidance is
built from them; this file records where it came from.

## 1. Which lessons are general, what it lacked at the start, what got in its way

Here are my answers to your three questions.

**Which of the five points are general**

Four of the five are general, though some need rewording. Point 5 is about this pipeline.

- _Sort each note by what it changes._ For an agent that knows nothing about Bloom: "Before changing anything, decide for each note which part of the video it touches: the words, the audio, things drawn over the picture (pointer, highlights, captions), the footage itself, or the order and timing. The answer decides how much has to be redone." The categories depend on how a video is built, so the agent also has to find out what each one is made from, which leads to the next point.
- _Redo only what a note affects._ The goal is general and the method isn't. The general wording: "Work out the smallest rebuild that makes the change. If the way this video is built forces a much larger redo than the note deserves, say so in your plan and don't just do it silently." In this session I re-recorded six minutes for four notes, two of which only touched the words, and the reviewer had to ask why.
- _Respect the voice switch._ I'd widen it: "Some steps cost money or can't be undone, such as generating a voice, publishing, or uploading. Coanda tells you which are allowed. When one isn't, reuse what exists, or leave a marked placeholder, and say in your reply which parts are placeholders."
- _Show an edit plan before acting._ This is general as it stands. The plan should list each note, its kind, what will be redone, and any reading of the note you aren't sure of. I'd add that the plan is where interpretation questions belong. For note 1, Hatton asked me to "just say this is an image placeholder." I kept an existing sentence that says roughly that, because rewording would have needed new audio. That was a judgement Hatton should have seen before the build, not only afterwards in a reply.
- _Start each project inside the main pipeline_ is about this repo. What's general in it: "Before your first edit, find out how this video is built and how to rebuild it. If you can't find out, ask; don't reverse-engineer it."

Three general points I'd add that weren't in my list:

- **Check each fix in the new render.** Look at frames at the moment each note covers, and confirm that nearby parts didn't change. I checked notes 2 and 3 frame by frame, and that's what made "done" true. For note 2 one frame wasn't enough: the bug was something disappearing just before a click, so I had to look at a strip of frames over the second before the click.
- **A re-cut moves the times.** Times after a removed section are no longer valid, so a reply should give the new time where each note's moment ended up.
- **Report every mismatch between the words and the audio.** After my edit the subtitle says "We typed on the pages." with a period, but the recording was spoken with a comma. That has to be in the reply, and I did put it there.

**What I'd have wanted to be told at the start**

- **Where this video's build recipe is.** `video-project.json` is `{}`. I found how the draft was made by reading the transcript of an earlier session. Coanda could require each video to have a recipe file, or a line in it, giving the source folder, the rebuild command, and which outputs are generated. When there isn't one, it could tell the agent to establish that first.
- **What voiceReady false means for the draft.** The instructions say to reuse the existing narration or a placeholder. I reused it, and Hatton was surprised there was a voice at all. Either the draft should be silent with subtitles until the switch is on, or reused audio is fine, and Coanda should say which.
- **That this is building a system.** If I'd known the video was a test bed for a process, I'd have raised "this pipeline can't do small edits" before re-recording, not after.
- **How much work a round is expected to take.** Re-recording took about ten minutes this time, and moving the video onto the main pipeline would take hours. One sentence such as "if a round needs more than X, propose it first" would have changed what I did.
- **Coanda's own rules, in Coanda's words.** For example, whether the reply should answer each note on its own or can refer to a shared fix.

**What got in my way from Coanda's side**

- **The frame images were the most useful thing in the annotation.** I couldn't have placed the pin for note 3 without one. For notes about something over time (note 2's "disappears just before we click"), a short run of frames, or the second before and after the pin, would have saved me extracting them myself.
- **Re-rendering to the same path destroys the version that was reviewed.** The old frame images now point at times in a video that no longer exists, and nobody can compare before and after. Keeping the previous render beside the new one, perhaps under a version number, would fix both problems.
- **Old times go stale with nowhere to put the new ones.** If a reply could carry a new time per note, Coanda could show each answer at the right moment in the new render.
- **The reply status is too coarse.** "done" and "question" apply to the whole turn. I needed "done with a caveat" for note 4 (the comma), and could have used "needs voice" for a note that can't be finished while the switch is off. A status per reply (done, partial, waiting on voice, question) would let Hatton see at a glance what's left.
- **voiceReady repeats on every annotation.** That's harmless, but it's a property of the video, so it belongs once per send, along with the recipe location if Coanda learns it.
- **Coanda doesn't show local slash-command output.** Hatton ran `/compact` and saw nothing. I could only confirm that it ran, from my side.
- **Messages sent while I'm working arrive fine.** Hatton's "I don't expect any voice" reached me mid-turn and I could answer it in the same turn.

I'm leaving the requirement list out of SKILL.md and LESSONS.md as you asked. The changes I made earlier for this video's notes are still in place: the shot list, `voice.mjs`, PLAN.md and the new drafts. Nothing is committed.

## 2. Pushbacks, a recipe for this video, an example edit plan, and versions

Your five points match what I meant. I'd push back on two of them, then the drafts, then versions.

**Two pushbacks**

On the edit plan (point 1): if the agent always stops and waits for approval, every round costs Hatton an extra exchange, including rounds where nothing is in doubt. I'd make the rule: write the plan every time; stop and wait only when it contains an interpretation you're unsure of, an irreversible or paid step, or work much bigger than the notes deserve; otherwise carry it out and put the plan at the top of the reply. Last round would have stopped, because of the note 1 wording and the full re-record. A round of four box fixes on a pipeline that draws boxes after recording wouldn't need to.

On the frame strip (point 5): one second either side is a sensible default. Keep `videoFile` alongside it, though, so the agent can pull more frames when the trouble sits outside that window. For note 2 the frames I needed were 0.2 to 1 second before the click, which a ±1 s strip would have covered, but that won't always be true.

**A. The recipe for this video**

The field names are general. Values are as they stand today. A `null` marks something I don't know, and I'd rather leave it visible than guess. Times are what this round took on this machine.

```json
{
  "title": "Bloom: Using the Basic Book Template",
  "remakeOf": "https://www.youtube.com/watch?v=NdvNuFcvwLg",
  "notes": "PLAN.md",

  "reviewOutput": "local/drafts/draft-voiced.mp4",
  "otherOutputs": [
    "local/drafts/draft-silent.mp4",
    "local/drafts/draft-subtitled.mp4",
    "local/drafts/draft-voiced.srt"
  ],

  "sources": {
    "shotList": "scripts/record.mjs",
    "narration": "scripts/record.mjs",
    "cards": "title/*.html",
    "otherScripts": "scripts/"
  },
  "generated": "local/",

  "environment": {
    "app": "Bloom, from the worktree D:\\update-video, started with its run-bloom skill",
    "setup": "Copy scripts/* into D:\\update-video\\src\\BloomE2E\\video\\ before recording; delete that copy afterwards",
    "env": { "VIDEO_WORK_DIR": "local/ (absolute path)" }
  },

  "steps": [
    {
      "name": "record",
      "run": "bash D:/update-video/src/BloomE2E/video/take.sh <take>",
      "makes": "local/takes/<take>/screen.mp4, events.json",
      "takes": "about 10 min",
      "cost": "free",
      "needs": "the Bloom stack running in D:\\update-video; a fresh host Bloom each take (take.sh starts one)"
    },
    {
      "name": "assemble",
      "run": "node <scripts>/assemble.mjs <take> local/title local/drafts/draft-silent.mp4 transcript.md",
      "makes": "draft-silent.mp4 and transcript.md (narration lines with their times)",
      "takes": "about 1 min",
      "cost": "free"
    },
    {
      "name": "voice",
      "run": "node <scripts>/voice.mjs transcript.md local/drafts/draft-silent.mp4 local/draft-voiced.mp4, then move the .mp4 and .srt into local/drafts/",
      "makes": "draft-voiced.mp4 and .srt",
      "takes": "about 2 min",
      "cost": "paid for every line not already in local/voice-cache/",
      "switch": "voiceReady; while it is off, set NO_NEW_VOICE=1 (reuse only)",
      "quirk": "the voice cache is looked for beside the output file, which is why the output is written to local/ first"
    },
    {
      "name": "subtitles",
      "run": "node <scripts>/subtitles.mjs transcript.md local/drafts/draft-silent.mp4 local/drafts/draft-subtitled.mp4",
      "takes": "seconds",
      "cost": "free"
    },
    {
      "name": "cards",
      "run": null,
      "makes": "local/title/bg43.png, text43.png, end43.png from title/*.html",
      "note": "made by an earlier session; how is not recorded"
    }
  ],

  "whatToRedo": {
    "narration wording": "voice (paid if the words are new). The picture is paced by the old words, so a much longer or shorter line also needs record.",
    "narration line removed": "record, assemble, voice, subtitles: this pipeline cannot cut the picture",
    "highlight box or pointer": "record, then the rest: they are drawn into the frames",
    "what Bloom does on screen": "record, then the rest",
    "title or end card": "cards, assemble, voice, subtitles"
  },

  "verify": "Extract frames from local/takes/<take>/screen.mp4 at each note's moment (events.json gives the times), then look at the review output"
}
```

`whatToRedo` matters most to the next agent. It tells them before they start whether a note means seconds of work or a re-record. Writing it out also shows where this pipeline is weak: in a pipeline that can cut the picture, removing a narration line is a cheap step, and here it isn't.

**B. The plan I should have shown before the last round**

```
Edit plan: draft-voiced.mp4, 4 notes

Redo: one full re-record (about 10 min), then a rebuild (about 3 min).
Why the whole video: notes 2 and 3 change things drawn into the recorded frames, and this
pipeline records in one continuous run. Notes 1 and 4 come along at no extra cost.
Paid or irreversible steps: none. The voice switch is off, so I reuse the existing
recordings of each line and generate nothing.

#  Time   Kind                        Change                                    How I'll check it
1  2:04   narration (removal)         Remove "If you don't add a picture,       Read the new transcript; listen
                                      the space stays empty. The flower is      around the flower shot
                                      not printed." Keep "In Bloom, this
                                      flower marks a space for a picture."
2  2:08   footage                     The change-image button vanishes before   Frames over the second before
                                      the click: Bloom shows it only while the  the click
                                      mouse is over the image, and the
                                      scripted mouse loses that. Keep the
                                      button shown until it is clicked.
3  2:38   overlay (drawn into frames) Draw the credits box round the text of    Frame at the box
                                      all four credit lines
4  5:11   narration + footage         Remove the second-language section and    Read the transcript; frames at
          (removal)                   the summary's "and made the book show     the end of the summary
                                      two languages". The line before it,
                                      "We typed on the pages," becomes the
                                      last line.

Readings to confirm
- Note 1: you wrote "just say this is an image placeholder". I'll keep the existing sentence,
  which already says that, so no new voice is needed. If you want the words "image
  placeholder", that line needs new audio, and with the switch off it would be a silent gap
  with a subtitle.
- Note 4: the last line was recorded as "We typed on the pages," with a comma. Its subtitle
  will end with a period, and until the voice is redone the audio may sound unfinished.

Not doing: no other changes to the narration, cards or pacing.

Times after this round: everything from 2:04 on moves earlier. My reply will give each
note's new time.

Go ahead, or change something?
```

The parts I'd keep in every plan: one line on what gets redone and why; paid or irreversible steps named, even when there are none; a row per note with its kind, the change and how it will be checked; readings to confirm, set apart; what won't be done; and whether the times will move. The "why the whole video" line is the one Hatton needed last round and didn't get until he asked.

**Versions**

I'd have Coanda keep the old file, with one change: make the copy when Hatton sends the notes, not when the file is overwritten. The render he annotated is the one the notes, frames and times refer to, so that is the one worth keeping. Copying at send time also avoids catching me halfway through writing the new file. Coanda can see the send happen, but it can't reliably tell when I'm about to overwrite. The copy is about 20 MB for this video, and a send happens a few times a day.

Numbered files would mean every agent and every recipe has to work out the next number and pass it through its build scripts. Some agent will forget, and the version history will then have a gap exactly where it matters. One small thing would help from my side: if the send told me where the reviewed version was saved, I could build before-and-after frame strips for my checks.

## 3. Inventory of its pipeline, and how a general toolkit would build this video

Each entry gives what the file does, its inputs and outputs, the tools it calls, which parts are general and which are about Bloom or this video, and what I'd change.

#### voice.mjs (135 lines)

- **Does:** voices each narration line and lays it at its time. Where a line runs past the next line's start, it freezes the picture for the difference. It mixes the clips, normalises to -16 LUFS, and adds a subtitle track timed to the real speech.
- **In:** `transcript.md` (a Markdown table: each line's start in the silent draft, and its words), the silent MP4, an output path. Optional settings: `ELEVENLABS_KEY`, `VOICE_ID`, `VOICE_MODEL`, `NO_NEW_VOICE`.
- **Out:** the voiced MP4 (H.264, AAC, `mov_text` subtitles) and an `.srt`. The cache goes in `<output folder>/voice-cache/<hash>.mp3` plus `<hash>.json`. The JSON is ElevenLabs' character alignment, so a cached clip's words can be recovered from it.
- **Calls:** the ElevenLabs `text-to-speech/{voice}/with-timestamps` API, sending the line before and the line after as context. ffmpeg (`trim`/`tpad` for the freezes, `adelay`/`amix`, `loudnorm`) and ffprobe.
- **General:** all of it. Only the default voice ID and model are this project's.
- **I'd change:**
  - Split it into three steps: decide each line's audio (reuse, gap, or generate), schedule the lines and freezes, render.
  - Key the cache on provider, voice, model and the words with final punctuation dropped. Keep the context and exact text as data inside the entry. Today the context is part of the key, which is why any edit makes the neighbouring lines miss the cache.
  - Take the cache folder as a setting, not "beside the output".
  - Read the lines from JSON, not by parsing a Markdown table.
  - Leave gaps for lines with no recording, and write the unvoiced list, the timeline, and a dry-run cost plan.

#### transcript.mjs (23 lines)

- **Does:** `readNarration` reads the narration table back out of `transcript.md` with a regular expression. `srtStamp` formats SRT times.
- **General:** yes.
- **I'd change:** make the lines JSON the real data, and the Markdown table only a view of it written for people to read and edit. Parsing a hand-edited table is fragile.

#### subtitles.mjs (41 lines)

- **Does:** writes subtitles for the silent draft, timed by estimate (0.4 s a word plus 1 s), and muxes them in.
- **In and out:** `transcript.md` and a video in; MP4 and `.srt` out. Calls ffmpeg.
- **General:** yes.
- **I'd change:** fold it into the voice step. A draft with no recordings is then the same as a voice build where every line is a gap, and the separate silent-with-subtitles path goes away.

#### gaps.mjs (19 lines)

- **Does:** lists the longest silences in an `.srt`.
- **General:** yes. Keep it as a check.

#### assemble.mjs (88 lines)

- **Does two jobs.**
  - The picture: a title card (the photo slowly zooms in while the text fades in, 4.4 s), the screen take fading in over it, and an end card fading in, 5 s.
  - The narration table: it writes `transcript.md` from the take's `events.json` (lines with their times plus the title offset, and what's on screen during each).
- **In:** the take's `screen.mp4` and `events.json`; `bg43.png`, `text43.png`, `end43.png`.
- **Out:** `draft-silent.mp4` and `transcript.md`. Calls ffmpeg and ffprobe.
- **General:** the card and fade structure, and the timing constants (`TITLE`, `FADE`, `END`).
- **Specific to this video:** 1536×1152 is hard-coded, the card file names are fixed, and the table's heading names this video and `src/BloomE2E/video/record.mjs`.
- **I'd change:** split the two jobs. Take the frame size, card files and durations from the recipe. The title offset should go into the timeline, not only into the table.

#### frames-to-mp4.mjs (32 lines)

- **Does:** turns screenshots taken at uneven intervals, each with a timestamp, into a steady 30 fps video. Each frame is held until the next one's time, using ffmpeg's concat demuxer.
- **In:** `frames/*.jpg`, `frames.json`, `events.json`. **Out:** `screen.mp4`.
- **General:** yes.

#### ffmpeg.mjs (17 lines)

- **Does:** finds ffmpeg and ffprobe: `FFMPEG_DIR` first, then the winget install, then the PATH.
- **General:** yes. The winget fallback is about this machine. Make the path a toolkit setting.

#### recorder.mjs (307 lines)

The recording machinery, mostly general for any app that can be driven over Chrome's remote debugging protocol (CDP).

- **Layout and capture (general):** emulates a 1024×768 screen at 1.5× scale. Captures with `Page.captureScreenshot`, three requests in flight (about 25 fps), stamping each frame's time.
- **Pacing (general):** `say` and `quiet` time the shots by an estimate of 0.43 s a word, and `estimateSpeech` gives that estimate.
- **Pointer and actions (general):**
  - The pointer is an SVG drawn into the page. Click rings and highlight boxes are injected CSS and HTML.
  - Moves are eased glides. Each step is also sent as a real mouse move, so hover effects happen.
  - Clicks call `element.click()`. Typing sends one key per letter. Scrolling eases `scrollTop`. Drags are synthetic mouse events. `union` and `pad` compute the highlight boxes.
- **Logging:** `events.json` holds the narration lines and a handful of `r.log` calls.
- **Calls:** Playwright (`connectOverCDP`) and CDP.
- **Specific to Bloom:**
  - `hideKey`, which hides the Pixabay API key in the Image Chooser.
  - The use of `connect()` from `bloom.mjs`.
  - Clicking by `element.click()` and scrolling by script. Bloom ignores real clicks and wheel input once screenshots have started, so this is a workaround for Bloom's embedded browser that another app may not need.
- **I'd change:**
  1. Stop drawing the pointer, click rings and highlights into the frames. Log their positions and times, and draw them when the video is built. This is the biggest change: it would have made both of Hatton's box notes a rebuild, not a re-record.
  2. Log a key for every click, move and keystroke, so the timeline has anchors everywhere.
  3. Record in sections, each starting from a saved state of the app.
  4. Let the project supply what to hide, as a list of rules. `hideKey` would become one entry in that list.
  5. Add a highlight that fits a stretch of text, built from my `creditLines` with today's fix. Fitting the box to an element's rectangle isn't enough: the rectangle is either too wide or too narrow.
  6. Make the capture method a choice: CDP screenshots, or screen capture of the window as the main pipeline does with `ddagrab`.

#### record.mjs (481 lines)

The shot list, mixing three kinds of content.

- **This video's content:** every `say` line and shot, and the Spanish text it types.
- **About Bloom:**
  - `topBarTab` and the `pageList`/`page` frames.
  - `thumbnail` and `showPage`, which handles the fact that a thumbnail's click target is its `.invisibleThumbnailCover`.
  - `waitForEditor` (CKEditor) and `typeInto`.
  - The Add Page dialog helpers.
  - Keeping the change-image button shown, because Bloom shows it with CSS `:hover`.
- **General:** `until` (polling with a named failure) and `creditLines`.
- **I'd change:** put the Bloom helpers with Bloom, beside run-bloom and its e2e fixtures, so the next Bloom video reuses them. Move the general ones into the recorder. Split the shot list into sections. Give each narration line an id, so a rewording doesn't change its identity.

#### bloom.mjs (35 lines)

- **Does:** reads `host.json` (ports), connects over CDP, finds the page with the workspace top bar, and saves screenshots.
- **About Bloom.** The general part is the job itself: the project gives the toolkit a way to get the page to drive.

#### host.spec.ts and playwright.config.ts (86 + 13 lines)

- **Does:** starts a separate Bloom through the BloomE2E launcher on a new "Spanish Books" collection, or on a copy of a saved one, with an empty user-settings folder. It restarts Bloom once with settings changed (production website, 80% zoom) and the collection's sign language cleared. It writes `host.json` and waits for a `stop` or `stop-and-save` file. `stop-and-save` copies the collection to `inputs/collections/`.
- **About Bloom.** The general pattern is starting the app from a named state and saving its state at the end. That pattern is what recording in sections needs.

#### take.sh (39 lines)

- **Does:** reads Vite's port from run-bloom, starts the host, waits for `host.json` plus 8 s, runs `record.mjs`, stops the host, then runs `frames-to-mp4`.
- **About Bloom** (run-bloom, pnpm in the e2e package). The sequence is general: start, wait until ready, record, stop, build the take.
- **I'd change:** the scripts must be copied into `D:\update-video\src\BloomE2E\video\` only because they import the e2e launcher by a relative path. A toolkit that imports a start/stop module supplied by the project removes the copying step.

#### explore.mjs (23 lines)

- **Does:** runs a few actions against the host at the video's screen size and saves a screenshot, for working out a new shot.
- **General idea**, Bloom connection. Keep it as a toolkit command.

#### Title cards (title/*.html, monarchs.jpg, the Bloom logo)

- This video's content. Rendering them is general: headless Chrome screenshots at the frame size, with a transparent background for the text layer.

### How this video would be laid out for a general toolkit

#### Voice

The toolkit needs the narration lines, with ids, words, and each line's start in the picture before any voice is added. The take provides the start times: the recorder logs each line when the shot list speaks it. The recipe's `voice` entry gives:

```json
"voice": {
  "provider": "elevenlabs",
  "voiceId": "XrExE9yKIg1WjnnlVkGX",
  "model": "eleven_v4",
  "plan": "free (10,000 characters a month)",
  "pricePer1000Characters": null,
  "cache": "local/voice-cache",
  "sendNeighbouringLines": true
}
```

The price is `null` because I don't know it; fill it in from the account. The free allowance is what the plan's name says and should be checked too.

The toolkit then does the rest, with no input from the project:

1. For each line: the cached recording of the same words, otherwise a gap of the estimated length. In a voice pass only, it generates the missing lines.
2. Schedule the lines and freezes.
3. Render, then write the `.srt`, `<name>.timeline.json` and the unvoiced list. A dry run writes the voice-pass plan: the lines, their character count, and the cost.

The one thing a project has to supply is the estimate of how long a line takes to say. 0.43 s a word suits this voice. It should be a recipe setting, because the recorder uses it for pacing and the voice step uses it for gaps, and the two must agree.

#### Timelines

The voice step writes the timeline, because only it knows the freezes. Each anchor's time is the title card's length, plus its time in the take, plus every freeze before it. The anchors are:

- every narration line, as `line: <words>`;
- every logged action, as `click: <name>`, `type: <name>` and so on;
- `end`.

What the project supplies is names for its actions. For example, the recorder's `click(locator, "Add Page")` logs `click: Add Page`. A sensible default would be the element's text or accessible name, so unnamed clicks still get a key.

#### The rest of the recipe

- `frame`: width, height, scale, fps (1024×768 at 1.5, 30).
- `cards`: the title background, title text and end card HTML; their durations and fades.
- `capture`: the method (CDP screenshots), and the rules for what to hide.
- `sections`: in order, each with a name, the shot-list module, the saved state it starts from (or "fresh"), and the state it saves at the end. For this video: setup and template; the pages every book has and the title; the cover picture; adding, moving and removing pages; typing; back to the collection and the summary.
- `app`: the path to a module the project supplies, which the toolkit calls to drive its app. It provides:
  - `start({ fromState })`, returning a page to drive;
  - `stop({ saveStateAs })`;
  - optionally, a way to check the app is ready.

  For Bloom, that module lives with Bloom, built from `host.spec.ts`, `bloom.mjs`, take.sh's ready check, and the Bloom helpers now in `record.mjs`.

#### What the project keeps

The shot-list sections, which call the toolkit's recorder and Bloom's helpers; the narration words inside them; the card HTML and images; the recipe. The training repo would hold only those.

## 4. Recorder design

I've added `"language": "eng"` to the recipe's `voice` entry, and the recipe still parses as valid JSON.

Each part below is marked with how sure I am of it:

- **[seen]** I ran it in this video's recorder.
- **[main pipeline]** It exists in `tools/record/bloomRecorder.mjs` and `tools/edit/edit-demo2.mjs`. I know it from HOW-IT-WORKS.md and the code, but I haven't run it.
- **[idea]** Untested.

**Start from both recorders, not from scratch.** The main pipeline already logs highlight positions (its `spot()`) and draws the pointer, click rings and boxes when the video is built. This video's recorder has the capture, pacing and Bloom handling that work for a CDP-driven app. The toolkit should combine the two.

### 1. What it records

- **The picture only, with nothing drawn on it.** Two ways to capture:
  - CDP screenshots at the emulated screen size and scale, three requests in flight, about 25 fps, each frame stamped with its time. **[seen]**
  - Screen capture of the app's window with the system pointer hidden (`ddagrab`, `draw_mouse=0`). This also covers native dialogs that CDP can't see. **[main pipeline]**

  The recipe picks one: `capture.method`.

- **Hiding rules from the project**, such as Bloom's Pixabay key: elements hidden while recording, set in the recipe. **[seen]**, as a hard-coded rule today.
- **Frames to video:** each frame is held until the next one's time, giving a steady 30 fps. **[seen]**

### 2. What it logs

One `events.json` per section. Times are seconds from the start of capture, and positions are CSS pixels of the emulated screen. The take's metadata gives the scale.

```json
{"t": 12.40, "kind": "line",  "key": "line: flower", "say": "In Bloom, this flower marks a space for a picture."}
{"t": 13.02, "kind": "move",  "x": 512, "y": 300}
{"t": 14.10, "kind": "press", "key": "click: Change image", "x": 640, "y": 210}
{"t": 15.30, "kind": "key",   "key": "type: search", "char": "m"}
{"t": 16.00, "kind": "box",   "id": "details", "x": 420, "y": 380, "w": 230, "h": 70, "on": true}
{"t": 18.10, "kind": "box",   "id": "details", "on": false}
{"t": 0,     "kind": "section", "name": "cover-picture"}
```

- `move` is logged at every step of a glide, every 16 ms, at the position the real mouse was sent to. **[main pipeline]**
- Every action gets a `key`. The project can pass a name, and otherwise the key comes from the element's accessible name or text. **[idea]** Today only a handful of actions are logged **[seen]**.
- `line` lets the narration key differ from its words (`r.say("flower", "…")`), so a rewording keeps the key and the notes stay with it. **[idea]**, though `say` itself is **[seen]**.
- The timeline for `coanda voice` comes straight from `line`, `press` and `key` events. Its format is what this video uses now **[seen]**.

### 3. Drawing at build time

- **Pointer.** An image placed every frame from the `move` samples, using ffmpeg's overlay driven by a command file. **[main pipeline]** (the `pointer.cmd` in `edit-demo2.mjs`).

  One constraint from this video **[seen]**: the real mouse still has to be sent along the same path, because hover effects (button highlights, tooltips, Bloom's image buttons) only appear for real moves. The drawn pointer has to follow the logged real path, not one tidied up afterwards. Otherwise hover effects show up where the pointer isn't.

- **Click rings** at each `press`. **[main pipeline]** in the build, **[seen]** drawn live in this video's recorder.
- **Highlight boxes** from `box` events, drawn on in about 0.4 s and held for at least 2 s. Colour, thickness and gap come from the recipe. **[main pipeline]**
  - If an element moves while its box is showing (a scroll, a re-layout), the recorder should log the box again whenever its rectangle changes. **[idea]**
- **A file of box corrections in the project.** Each entry names a box id and gives a replacement rectangle or padding; the main pipeline's `spots` in `story.mjs` does this **[main pipeline]**. This would have turned both of Hatton's credits-box notes (3 and 5) into a rebuild with no re-record: when the measuring code is wrong, the box can be fixed by hand without touching the recording.
- **A box that fits text.** `r.highlight(id, target, { fitText: true })` takes the union of the text lines' rectangles inside the target, including a line when its middle falls inside. **[seen]** in its first version, which was wrong; the fixed version is untested, because note 5's re-record hasn't run.
- **A check sheet before every send.** One frame per box, at its midpoint, with the box drawn, so the agent looks at each box before Hatton does. **[idea]** I'd have caught note 5 with it.
- **Speed changes** (glides at a calm speed, idle stretches trimmed) belong in this same build step **[main pipeline]**. They can wait until after the first version.

### 4. Recording in sections

- **The recipe lists the sections in order.** Each has a name, its shot-list module, the saved state it starts from (`"fresh"` for the first), and the state it saves at the end:

  ```json
  "sections": [
    {"name": "template",      "script": "shots/template.mjs", "from": "fresh",        "saves": "book-made"},
    {"name": "cover-picture", "script": "shots/cover.mjs",    "from": "titled",       "saves": "with-picture"}
  ]
  ```

- **Recording one section:** `app.start({ fromState })`, run the section, then `app.stop({ saveStateAs })`. The section's frames, events and saved state go under `local/sections/<name>/`. **[idea]** The parts it needs exist for Bloom: `host.spec.ts`'s `stop-and-save` and `VIDEO_COLLECTION_NAME`. They're written **[seen as code]**, but I haven't run them.
- **Assembly** joins the sections in order and offsets each section's events by where it starts. A short dissolve at each join hides small differences. **[idea]**
- **What can go wrong** **[idea]**, from what I know of Bloom:
  - Re-recording a section can change the state that later sections start from. Bloom picks a new cover colour for each book, so re-recording the section that makes the book changes the colour in every section after it **[seen: takes differ in colour]**. Rule: re-recording a section whose saved state differs makes every later section stale too. The build should say which sections are stale, rather than quietly joining footage that doesn't match.
  - State held in the script, like the page ids `record.mjs` passes from one shot to the next, can't cross a section boundary. Each section has to find what it needs again (by caption, by text).
  - `whatToRedo` gets a new row: "footage inside one section: re-record that section, plus any later section whose starting state changed."

### 5. What a project supplies

```js
// app.mjs: how to start, reach and stop the app. For Bloom it lives with Bloom (run-bloom / BloomE2E).
export async function start({ fromState, workDir }) {
  // launch, wait until ready; return what the recorder drives
  return {
    page,
    stop: async ({ saveStateAs }) => {
      /* save state, then quit */
    },
  };
}
export const hide = [{ selector: "...", why: "API key" }]; // optional

// shots/<section>.mjs: one per section; content plus the app's own helpers
export default async function (r, app) {
  await r.say("flower", "In Bloom, this flower marks a space for a picture.");
  await r.highlight("canvas", app.helpers.canvas(), { pad: 2 });
  await r.click(app.helpers.changeImageButton(), "Change image");
}
```

- **The recorder's commands for a shot list:** `say`, `quiet`, `wait`, `until` (polling that fails with a named reason), `moveTo` and `moveToElement`, `click`, `type`, `scroll`, `drag`, `highlight` and `unhighlight`. **[seen]**, all in `recorder.mjs` today, except the action keys and `fitText`.
- **Clicks.** By default the recorder clicks by calling the element's own `click()` and sends real mouse moves. **[seen]**: Bloom ignores real clicks once screenshots have started. For other apps, the project should be able to choose real clicks **[idea]**.
- **The project's helpers stay with the app.** For Bloom: page thumbnails, waiting for CKEditor, the Add Page dialog, keeping the change-image button shown. They live beside run-bloom, so the next Bloom video reuses them. **[seen]** as code, in `record.mjs` today.
- **Native windows** (Bloom's WinForms dialogs) need window capture plus UI Automation actions that log their keys through `r.logAction`. **[main pipeline]** has `spotNative`. Everything else about native windows is **[idea]**.

### Order I'd build it in

1. The log format and drawing at build time, with box corrections and the check sheet. This turns every pointer and box note into a rebuild.
2. `app.mjs` for Bloom, made from `host.spec.ts`, `bloom.mjs` and take.sh's ready check, plus the Bloom helpers split out of `record.mjs`.
3. Sections. This is the largest step and the least proven. I'd try it on this video by splitting its six parts and re-recording only the cover-picture section for note 5.
