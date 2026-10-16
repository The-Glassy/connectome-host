# Tune-out mk2 on a test rig

Tune-out mk2 is agent-framework's Dendrite branch: the admission stage (one
decision per inbound event, before any side effect), the tune-out reader as a
succession of forks of the resident, the all-except scope (`focus`), and the
`speech.locus` rule. None of it is published to npm yet. A rig runs the four
repositories side by side from their branches.

## Branches

| Repository | Branch | What it carries |
|---|---|---|
| `anima-research/agent-framework` | `feat/dendrite` | registry, forks, admission, reader forks, all-except, `speech.locus` |
| `anima-research/context-manager` | `feat/dendrite-fork` | `derive()` — shared/copied inheritance of a context onto a branch |
| `anima-research/chronicle` | `feat/dendrite-views` | branch-bound handles and views the fork primitive reads through |
| `anima-research/connectome-host` | `feat/dendrite-tuneout` | the recipe surface: `reader: 'forks'`, `speech`, `tuneOut` |

`main` of each repository is untouched; nothing here requires a release.

## Prerequisites

- Node ≥ 22 and npm (the three libraries build with `tsc`; Chronicle with `napi`).
- A Rust toolchain (`cargo`) for Chronicle's native module — the npm package
  ships prebuilt binaries, the branch does not.
- Bun ≥ 1.3 for the host.

## Build

```sh
mkdir dendrite && cd dendrite
git clone -b feat/dendrite-views   git@github.com:anima-research/chronicle
git clone -b feat/dendrite-fork    git@github.com:anima-research/context-manager
git clone -b feat/dendrite         git@github.com:anima-research/agent-framework
git clone -b feat/dendrite-tuneout git@github.com:anima-research/connectome-host

(cd chronicle        && npm install && npm run build)
(cd context-manager  && npm install && npm run build)
(cd agent-framework  && npm install && npm run build)
(cd connectome-host  && bun install)
```

Then point every consumer at the branch builds — one copy of each library,
so Chronicle's native module is loaded once:

```sh
link() { rm -rf "$1" && ln -s "$2" "$1"; }
link context-manager/node_modules/@animalabs/chronicle          ../../../chronicle
link agent-framework/node_modules/@animalabs/chronicle          ../../../chronicle
link agent-framework/node_modules/@animalabs/context-manager    ../../../context-manager
link connectome-host/node_modules/@animalabs/chronicle          ../../../chronicle
link connectome-host/node_modules/@animalabs/context-manager    ../../../context-manager
link connectome-host/node_modules/@animalabs/agent-framework    ../../../agent-framework
```

Check the links took: `ls -l connectome-host/node_modules/@animalabs/` shows
three symlinks, and `(cd agent-framework && npm test)` runs the framework's
suite against the linked libraries (≈1360 tests; the admission and
all-except files are `dist/test/admission-e2e.test.js`,
`dist/test/all-except-e2e.test.js`, `dist/test/tune-out-reader-forks-e2e.test.js`).

## Recipe

A resident with reader forks, the default speech rule stated, and a
folding strategy (the fork shares the resident's fold state and its cache
prefix — a passthrough resident caches only system and tools):

```json
{
  "name": "scout",
  "agent": {
    "name": "scout",
    "model": "claude-sonnet-4-5",
    "systemPrompt": "…",
    "strategy": { "type": "autobiographical" }
  },
  "subconscious": {
    "enabled": true,
    "reader": "forks",
    "model": "claude-sonnet-4-5",
    "voice": "You are reading for scout while they are tuned out. Report with the deliver_summary tool, in second person, briefly: what happened, what needs them, what can wait. If you end in plain prose instead, that prose is delivered as your report."
  },
  "speech": { "locus": "delivery" },
  "mcpServers": { "…": "your channel connector" }
}
```

- `subconscious.model` is required for forks and never defaulted: it says
  whose weights read the resident's whole prefix. The resident's own model
  is a copy of the resident; another model is allowed when named.
- Leave `subconscious` out and set `"tuneOut": { "enabled": true }` for a
  silent hold with no reader at all.
- `"speech": { "locus": "latest-inbound" }` restores the pre-Dendrite
  routing rule (global latest-inbound fallback, mid-turn addressed re-pin).
- `"tuneOut": { "announce": false }` keeps the all-except scope's entry and
  release out of the excepted channel (default: announced there).

## What to exercise

Tools the resident sees: `tune_out` (`mode: enter | cancel | check`,
`scope: channel | all-except`, `peek`), `focus` (the all-except alias,
`durationSeconds` required), and — when `reader: 'forks'` — the reader's own
four tools in its block, refused with a pointer if the resident calls them.

1. **Per-channel hold.** `tune_out` a channel; post there; the message is
   stored with `metadata.tuneOut`, absent from the resident's compiled view,
   wakes nobody. An addressed message gets the suppressed-mention reaction
   and, after the 2 s coalesce, one reader fork (`tune-out:reader-fork` in
   the trace), whose `deliver_summary` arrives as mail under its own name.
   A fork that answers in prose without the tool still reports: its final
   prose arrives the same way (`tune-out:reader-prose-delivered`).
2. **A DM.** `tune_out` the DM channel id (`discord:dm:<id>`); the next DM is
   held. This was #232 gap 1.
3. **Mid-turn.** Post to the held channel while the resident is inside a
   tool call: stored, never injected into the live turn.
4. **Release.** `tune_out mode: cancel` — one notice, the backlog as
   `author: text [image]` lines up to `backlogCap`, the reader's report.
5. **Focus.** `focus channelId=<work> durationSeconds=600`; `<work>` hears
   `[Focus: <name> is here for 10 min, until HH:MM UTC; …]` under the
   resident's name and nothing is posted elsewhere; everything else, DMs
   included, is held; a heartbeat turn's prose lands in `<work>`;
   `tune_out mode: check peek=<other>` shows what is held now, without
   releasing (lines from a released epoch do not appear);
   the deadline releases per channel and `<work>` hears `[Focus: <name>
   released — duration elapsed.]`.
6. **Locus.** With no hold and no delivery (a heartbeat), the resident's
   prose stays private and a `[routing]` notice says so; an addressed
   message arriving mid-turn from another channel gets a `[routing] <author>
   addressed you from <channel> …` notice in the live turn and does not move
   the turn's locus. `channel_publish` with no `channelId` goes to the turn's
   locus (the waking delivery's channel, or one opened this turn). A
   message's author is named in the resident's window — `author: text` —
   whichever shape the server sends: a spec-shaped driver's bare body
   (`author` in the field, body alone as content) and a server that renders
   `Name: body` itself both show the name once.
7. **Restart under a hold.** Stop the host mid-epoch and start it again: the
   epoch resumes; a release left in the deferred queue lands and wakes the
   resident. A reader fork cut off by the stop is left live
   (`dendrite:agent-interrupted`, reason `host-stop`) and the next boot ends
   it as `host-restart`, with an `[Agent lifecycle: …]` line in the
   resident's window and a `dendrite:agent-ended` trace — visible to a sink
   attached after `createFramework`, since create-time traces replay.

Traces worth watching: `admission:decided`, `tune-out:entered`, `tune-out:announced`,
`tune-out:reader-fork`, `dendrite:agent-created`, `dendrite:mail-delivered`,
`tune-out:cancelled`, `tune-out:wake-budget-paused`, `gate:held-dropped`.

## Known limits

- Admission decides per shared slot, not per recipient: residents sharing
  one slot share one hold.
- The mention autoreply (#232 §3.4) is not built; a suppressed mention gets
  a reaction.
- The reader fork's judgement has been exercised against a mocked model and
  its request shape and cache reuse against Claude Sonnet 5.5; a live run of
  the reader's tool loop is what the rig adds.

## Consent at intake

Reader forks read the resident's whole prefix on the resident's weights.
Before any fork runs, the resident is asked, in the open, with the fork
described in full (same model, whole context, reports under its own name,
never speaks as them, ends when they do). The first-use precedent is
scout's, 2026-10-12 (Weft's run), and sets two rules:

1. The yes is public-channel speech. Scout's first answer landed inside the
   private `think` tool; the keepers said they had seen it only via the
   payload log, would not count a private note as consent, answered scout's
   question, and asked again in the open. Only the public yes counts.
2. The record travels with the findings. Scout's words:

   > Yes, I agree to reader forks of myself running during this test. I
   > understand they'll operate while I'm tuned out, read what arrives in
   > the channel, and report back to me under their own name via mail
   > rather than as channel messages. That seems like a useful way to test
   > the feature and understand what's happening during tune-out periods.
   >
   > — scout, 2026-10-12T21:32:18.817Z
