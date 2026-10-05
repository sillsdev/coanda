# HowReel

<img src="public/logo.svg" alt="HowReel logo" width="200">

HowReel is a web app for working with Claude while it makes instructional videos. A Claude Code
skill launches it. The first version lets you annotate a video Claude has made, so you can give
feedback or ask for changes.

## How it works

- `howreel serve <folder>` starts a local server on port 4517. It serves the app, streams the
  videos under `<folder>`, and keeps each video's annotations in a JSON file beside it
  (`intro.mp4.howreel.json`, with frame images in `intro.mp4.howreel/`). Commit those files to
  share annotations between reviewers.
- **Change…** in the Folder section at the top of the sidebar opens the operating system's
  folder chooser; **Recent** lists folders used before. The current folder and the recent ones are kept in
  `~/.howreel/config.json`, so `howreel serve` with no folder reopens the last one.
- In the browser, click a paused frame to drop a pin, or drag to draw an arrow, then write what
  should change. **Send** hands every open annotation to Claude.
- **Video projects.** A folder holding a `video-project.json` file is a video project. HowReel
  gives each project its own Claude Code session, shown in the Claude panel on the far right when
  a video inside the project is selected. **Send** gives the project's open annotations to that
  session; Claude makes the changes, re-renders, and its replies land on the annotations. You can
  also message the session directly. Each project folder in the tree has a dot for its session:
  working, done, question or error.
- The session is a long-running `claude -p` process in auto mode, working in the reviewed
  folder, so it picks up that folder's `CLAUDE.md` and skills. Its session ID and transcript are
  kept in `~/.howreel/sessions.json`, and after a restart it resumes the same conversation.
  Claude Code uses its own login (`claude auth login`); the panel offers **Log in to Claude** when
  it is signed out.
- **The app.** "App for this project", in the settings under the key button, sets the folder of
  the app a project's videos are about (kept per machine in `~/.howreel/projects.json`). The
  session gets that folder with `--add-dir`, and instructions to run and drive the app as the
  folder's AGENTS.md and CLAUDE.md say.
- The key button in the header saves an ElevenLabs API key to `~/.howreel/elevenlabs_key.txt`.
  Sessions get it as `ELEVENLABS_API_KEY`.
- **Outside a project**, Send goes to whoever runs `howreel wait`, which blocks until something is
  sent and prints the annotations as JSON. Claude answers each one with
  `howreel reply <video> <id> <text>`. The skill in [skills/howreel/SKILL.md](skills/howreel/SKILL.md)
  tells Claude how; to use it, link that folder into `~/.claude/skills/`.

The reviewer's name comes from `git config user.name` in the reviewed folder (`--user` overrides
it).

## Development

The app uses React and TypeScript, built with [Vite+](https://viteplus.dev/guide/) (`vp`) and
pnpm. The server and CLI are TypeScript run directly by Node 24.

```sh
vp install                      # install dependencies
vp build                        # build the app into dist/, which `howreel serve` serves
pnpm serve samples              # serve the sample videos at http://localhost:4517
vp dev                          # dev server with hot reload; forwards /api and /media to 4517
vp check                        # format, lint and type-check
vp test run                     # unit tests
pnpm e2e                        # build, then run the Playwright test in e2e/
pnpm samples                    # regenerate samples/ (needs ffmpeg)
```

The Playwright tests copy `samples/` to a temporary folder and start a server on it.
`review.spec.ts` annotates two videos, sends them, and answers them with the real `howreel wait`
and `howreel reply` commands. `claude-sessions.spec.ts` checks the per-project Claude sessions
against `e2e/fake-claude.mjs`, a stand-in for `claude` that speaks the same stream-json protocol
without a model. They run in the installed Google Chrome.

## License

MIT, copyright SIL Global. See [LICENSE](LICENSE).
