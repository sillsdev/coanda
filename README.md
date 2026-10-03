# Coanda

<img src="public/logo.svg" alt="Coanda logo" width="200">

Coanda is a web app for working with Claude while it makes instructional videos. A Claude Code
skill launches it. The first version lets you annotate a video Claude has made, so you can give
feedback or ask for changes.

## How it works

- `coanda serve <folder>` starts a local server on port 4517. It serves the app, streams the
  videos under `<folder>`, and keeps each video's annotations in a JSON file beside it
  (`intro.mp4.coanda.json`, with frame images in `intro.mp4.coanda/`). Commit those files to
  share annotations between reviewers.
- In the browser, click a paused frame to drop a pin, or drag to draw an arrow, then write what
  should change. **Send** hands every open annotation to Claude.
- Claude runs `coanda wait`, which blocks until something is sent and prints the annotations as
  JSON. Claude makes the changes, re-renders the video in place, and answers each one with
  `coanda reply <video> <id> <text>`. The open page shows the replies and the new render.

The skill in [skills/coanda/SKILL.md](skills/coanda/SKILL.md) tells Claude how to do all of
this. To use it, link that folder into `~/.claude/skills/`.

The reviewer's name comes from `git config user.name` in the reviewed folder (`--user` overrides
it).

## Development

The app uses React and TypeScript, built with [Vite+](https://viteplus.dev/guide/) (`vp`) and
pnpm. The server and CLI are TypeScript run directly by Node 24.

```sh
vp install                      # install dependencies
vp build                        # build the app into dist/, which `coanda serve` serves
pnpm serve samples              # serve the sample videos at http://localhost:4517
vp dev                          # dev server with hot reload; forwards /api and /media to 4517
vp check                        # format, lint and type-check
vp test run                     # unit tests
pnpm e2e                        # build, then run the Playwright test in e2e/
pnpm samples                    # regenerate samples/ (needs ffmpeg)
```

The Playwright test copies `samples/` to a temporary folder, starts a server on it, annotates
two videos, sends them, answers them with the real `coanda wait` and `coanda reply` commands, and
checks the page at each step. It runs in the installed Google Chrome.

## License

MIT, copyright SIL Global. See [LICENSE](LICENSE).
