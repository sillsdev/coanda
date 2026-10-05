# HowReel

<img src="public/logo.svg" alt="HowReel logo" width="200">

HowReel is a web app for working with Claude while it makes instructional videos. A Claude Code
skill launches it. The first version lets you annotate a video Claude has made, so you can give
feedback or ask for changes.
<img width="2800" height="1528" alt="image" src="https://github.com/user-attachments/assets/9f2c7e6f-332d-44a9-bb96-f16b3f7b38cc" />

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
