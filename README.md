

# <img src="public/logo.svg" alt="HowReel logo" width="200"> HowReel

HowReel is a tool making instructional videos collaboratively with an AI. 

<img width="2791" height="1513" alt="image" src="https://github.com/user-attachments/assets/5c88f98f-45f5-46cc-944f-62a70ae9ea27" />


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
