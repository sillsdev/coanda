<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# UI text

Do not add explanatory text to the UI. Things that need a label get a short label, and nothing
else gets text.

- No instructions or hints ("Click the frame to comment", "Ctrl+↵ to save").
- No empty-state messages ("No annotations yet", "Choose a video on the left"). Leave the area
  empty.
- No status sentences. A control's state says it: a Send button with nothing to send is
  disabled, not relabelled "Nothing new to send".
- No footnotes explaining what a button does.

A count on a label ("TODOs & Questions 0 open") is fine. A placeholder in an input, kept to a
few words, is fine. The one empty-state hint, in the TODOs & Questions list, is there because
Hatton asked for it; don't take it as licence for others.

# Messages from video agents

The Claude sessions HowBench runs for video projects send problems they find in HowBench (its
commands, the recorder, `agent/guidance.md`) to a session working here, by SendMessage. Fix
each one when it arrives, as you would a request from Hatton, and tell Hatton what came in and
what you changed.
