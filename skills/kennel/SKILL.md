---
name: kennel
description: Delegate coding and video work to Kennel HQ, the user's pack of Claude Code worker dogs (Chou plans and leads, Harley writes app code, Asky does UI/UX design, Biscuit writes documentation, Bacon does databases, Pitchie does tests/QA, Tiger does CI/deploy, Lucifur explains and teaches) plus a video studio of cats (Seah edits, Yuki does motion graphics, Shadow colors, Snow does sound and captions, Goose makes shorts and thumbnails) that work in the current project with automatic QA, lessons and a shared brain. Use when the user says to send or give work to the pack, the kennel, the dogs or a dog by name ("ipasa kay Harley", "ipagawa sa pack"), asks what the dogs did or found, or wants to teach them a rule.
---

# Kennel HQ

Kennel HQ runs a team of headless Claude Code workers on the current project. You hand them tasks with the `kennel` CLI, wait, then check and report what they did. They use the user's own Claude login and share one 5-hour usage limit with you.

## 1. Make sure it's running

```bash
kennel status
```

If it says Kennel isn't running, start it in the background (Bash with `run_in_background: true`), wait a few seconds, then run `kennel status` again:

```bash
kennel serve
```

`kennel status` prints the office URL (http://localhost:4321 or nearby). Give it to the user so they can watch the dogs work. If `kennel` itself isn't found, tell the user to install it with `npm i -g kennel-hq`.

## 2. Send the work

```bash
kennel ask "<task>" --wait
```

Run it with `run_in_background: true`. Jobs take minutes, and you'll be notified when the report is ready.

- If the user names a dog or cat, add `--dog <name>`: dogs `chou|harley|asky|bacon|pitchie|tiger|biscuit|lucifur`, cats `seah|yuki|shadow|snow|goose`. Otherwise let Kennel route it. Asky handles UI/UX and styling. Biscuit handles documentation. Lucifur only explains (read-only), so use him when the user wants to understand something.
- Video work goes to the cats in the video studio upstairs: Seah (lead editor: cuts, pacing, ffmpeg, exports), Yuki (motion graphics in Remotion: titles, intros, animations), Shadow (color grading, VFX, green screen), Snow (audio mix, loudness, captions/subtitles), Goose (shorts/reels, thumbnails, platform delivery). For a whole video project, use `--plan` and Seah splits it among the cats. Video work needs ffmpeg (and Node for Remotion) on the machine.
- For a request with several parts, add `--plan`. Chou splits it into ordered tickets. Long or multi-part requests get planned automatically.
- Send one `kennel ask` per separate request. Don't resend something that's already queued (check `kennel status`).

The dogs can't see this conversation. Make each task self-contained:
- what to do and why
- the files or areas involved, if you know them
- what "done" means (behaviour, tests that should pass)
- any constraints the user stated (don't touch the UI, use pnpm, no production, …)

Example: `kennel ask "In src/cart.ts, total() skips the first item (loop starts at 1). Fix it and add a regression test in tests/cart.test.ts. Don't change any UI." --wait`

## 3. Check before you report

The `--wait` report lists each job with an id, a status, a summary, the files changed, the QA verdict, lessons learned and errors. Before telling the user something is done:

- Look at the actual change (`git diff -- <files>`). Don't just relay the dogs' claims.
- For details, run `kennel read <id>`.
- Items marked `! NEEDS YOU` failed QA twice. Explain what's wrong in plain words and ask the user how to proceed.
- `✓ small + self-tested` means QA was skipped on purpose because the change was small and already tested.

Then tell the user in a few lines: what changed, where, whether QA passed, and anything they need to run or decide.

## 4. Corrections and preferences

- The work is wrong: run `kennel bad <id> "<what's wrong and what right looks like>" --wait` (in the background). That dog learns from it and fixes it in the same session.
- The user states a rule for the future ("we use pnpm", "never touch prod"): run `kennel teach team "<rule>"`, or `kennel teach <dog> "<rule>"` for one dog.
- To see what they've learned: `kennel lessons [dog]`.
- To copy what Claude Code remembers about the user into the pack: `kennel import-claude`.

## Other commands

| Command | What it does |
|---|---|
| `kennel status` | who's working, queues, QA backlog, 5h limit used |
| `kennel wait` | wait for the current work to finish and print the report |
| `kennel brain [search]` | recent memories with ids |
| `kennel qa --wait` | run QA now on unchecked work |
| `kennel stop` | stop the background server (only if the user asks) |

## Care

- By default the dogs have full access (`--dangerously-skip-permissions`): they can run any command in the project. Before sending anything that touches production, real data, deploys, payments or paid APIs, confirm with the user first.
- If `kennel status` shows the 5h limit above about 80%, mention it before sending big jobs. Kennel pauses new work at 95%.
- Don't stop the server or delete `.kennel/` unless the user asks.
