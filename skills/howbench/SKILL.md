---
name: howbench
description: Open HowBench, the video review app, on a folder of videos Claude has made, so the user can annotate them in the browser and send the annotations back. Then act on each annotation, re-render, and reply in the app. Use when the user says "/howbench", "let me review the videos", "open the videos in HowBench", or asks to give feedback on videos you rendered.
---

# HowBench: review videos with the user

HowBench is a local web app. The user clicks or drags on a paused frame to leave an
annotation, then clicks **Send**. You receive the annotations, make the changes, re-render
the video file in place, and reply to each annotation. The replies show up in the app
while it is open.

`<howbench>` below is the root of the HowBench checkout: two folders above this skill.

## 1. Start the app

1. If `<howbench>/dist/index.html` is missing, build it: `pnpm -C <howbench> install` and then
   `pnpm -C <howbench> build`.
2. Start the server as a **background** command, on the folder that holds the videos
   (subfolders are fine; the tree in the app mirrors them):

   `node <howbench>/server/cli.ts serve <video folder>`

   Leave out `<video folder>` to reopen the folder used last time. The user can also switch
   folders in the app's sidebar.

   The server listens on port 4517 (`--port N` or `$HOWBENCH_PORT` to change it). The Bash
   sandbox refuses to open listening sockets, so this command has to run outside it; ask the
   user to approve that. If the port is taken, a HowBench server may already be running there.

3. Give the user the bare URL: `http://localhost:4517`

## 2. Wait for a send

Run this as a **background** command, so you are told when it exits:

`node <howbench>/server/cli.ts wait`

It prints a JSON array when the user clicks Send (or at once, if annotations were sent while
nothing was waiting). Each entry has:

- `video`: path relative to the folder; `videoFile`: absolute path
- `t`: seconds into the video
- `kind`: `pin` (at `x`,`y`) or `arrow` (from `x`,`y` to `x2`,`y2`); coordinates are
  percentages of the frame's width and height
- `text`: what the reviewer asked for; `author`: who asked
- `thread`: earlier replies, yours (`who: "claude"`) and the reviewer's (`who: "user"`).
  When the last message is the reviewer's, they are answering your earlier reply.
- `frameFile`: a PNG of the frame they annotated. **Read it**: the pin or arrow position is
  only meaningful against that picture.

Drafts are silent, with the narration as subtitles (`howbench subtitles`): never add voice to
one. Voice-over costs money, and comes once, at the end, when the reviewer asks for the voice
pass.

## 3. Make the changes and reply

For each annotation:

1. Make the change in the video's source, and re-render **to the same file path**. The app
   watches the file and tells the reviewer there is a new render.
2. Reply with what you did, in a sentence or two:

   `node <howbench>/server/cli.ts reply <video> <id> "Moved the title 40px right so it is no longer clipped."`

   Use `-` as the text to read a longer reply from stdin. If you could not do it, or need a
   decision, say so in the reply instead.

Then start `wait` again (step 2) for the next round. Keep going until the user says the
review is done; then stop the background server.
