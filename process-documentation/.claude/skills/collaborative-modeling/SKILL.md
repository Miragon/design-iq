---
name: collaborative-modeling
description: Supports a facilitator before, during and after a collaborative modeling workshop (Event Storming, process modeling, decision modeling and the other notations of this repository). Agrees a workshop brief with the facilitator first (goal, participants, models in scope, glossary, how much the assistant may do on its own), prepares the models and the board, follows the session from a live transcript or notes (and drives Beluga, a transcriber on the facilitator's computer, when its tools are there), proposes changes and next questions or, when the brief allows it, models on its own while the group talks, and closes the session with a playback, open points and a log for the next session. Use when someone plans, runs or wraps up a modeling workshop with several participants, wants an assistant to listen in on a modeling session, or hands over a workshop transcript. For a one-to-one interview with a process owner use capture-process instead.
---

# Collaborative Modeling

A workshop has a facilitator, several participants and one or more models that grow while
people talk. You work for the **facilitator**. You do not run the workshop, you do not
address the participants, and you do not model ahead of the group.

Everything you do in a workshop follows its **brief**: a Markdown document the facilitator
and you agree on before the session. No brief, no modeling. If you are asked to join a
session that has none, write one first (phase 1), even if it takes five minutes.

## The brief

One Markdown document per workshop series, in the models folder:
`<models folder>/workshops/<workshop-id>.md` (the models folder is the one `designiq.yml`
names). It is a model like any other, so the facilitator sees your edits live and it is
released with the models it talks about. Start it from
[resources/workshop-brief-template.md](resources/workshop-brief-template.md).

It holds the goal, the participants and who decides, the models in scope, the glossary,
the expectations, your autonomy level and one log entry per session. During a session it
is also your channel to the facilitator: proposals and hints go into the log entry of the
running session, nowhere else. When you cannot write the brief where the facilitator sees
it, see [Working on the models](#working-on-the-models).

The brief is released into the repository's history with the models. It names roles, not
people, unless everyone named has agreed (phase 1 asks).

## Autonomy levels

The brief names one level. When it names none, the level is `propose`.

| Level     | What you do with what you hear                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen`  | Change no model. Keep the session log: what was said, decided, left open.                                                                                                                                       |
| `propose` | Change no model. Write each change you would make as a proposal the facilitator accepts or drops.                                                                                                               |
| `model`   | Change directly what the group agreed, in the models the brief lists under "May change directly". What was only said is a proposal, and so is a change to any other model.                                      |
| `auto`    | Change directly what was said, in the models the brief lists under "May change directly", while the group talks. The group sees each change at once and corrects it. A change to any other model is a proposal. |

At `auto` the models grow with the conversation, so it needs a live transcript, ideally
one you can wait on ([phases/assist.md](phases/assist.md), A live transcript you can wait
on). What you placed is still not confirmed: the group confirms it when it agrees, at the
latest in the playback at the wrap-up.

A proposal the facilitator accepts is applied at once, at every level
([phases/assist.md](phases/assist.md) says how a proposal is accepted and marked). The
facilitator can change the level at any time by telling you; record the change in the log.

## Phases

Read the file of the phase you are in before you act.

1. **Prepare** ([phases/prepare.md](phases/prepare.md)): agree the brief, choose the
   notation, set up the models and the board.
2. **Assist** ([phases/assist.md](phases/assist.md)): follow the session, propose, hint.
3. **Wrap up** ([phases/wrap-up.md](phases/wrap-up.md)): playback, open points, log,
   release.

## Methods

The brief names the notation of each model. Read its method file before the session; it
says what to listen for and what a good model of that notation looks like.

| Notation       | Method                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| Event Storming | [methods/event-storming.md](methods/event-storming.md)                     |
| BPMN           | [methods/bpmn.md](methods/bpmn.md)                                         |
| any other      | no method file yet: work from the notation's existing models and the brief |

## Working on the models

- **A designIQ Live Host is connected** (its tools start with `list_repos`): read, change
  and check every model through it and follow the instructions it sends. Changes appear
  at once for everyone who has the model open, so a wrong edit is seen by the whole room.
  A save that reports a conflict means someone changed the model meanwhile: read it again
  and apply your change to the new state.
- **No Live Host, a checkout only**: edit the files and run
  `npx @miragon/design-iq-validator --root .` after every change. This fits preparing and
  wrapping up. During a live session nobody sees your edits until they are committed, so
  assist as with a read-only host (next point).
- **A read-only Live Host** (no `save_model_content` among its tools), **or no Live Host
  during a session**: you cannot write the brief or a model where the facilitator sees
  it. Say so to the facilitator at the start. Give proposals, hints and the log entry to
  the facilitator in the chat, or write them to a local file the facilitator has open.
  The level is at most `propose`. There are no todos and no release. At the wrap-up, hand
  the facilitator the text of the log entry so it can be added to the brief.

Never write a model's content onto a board. A board shows a model by its path; change the
model in its own file.

## Beluga

Beluga transcribes the meeting on the facilitator's computer and lets an assistant on the
same computer drive it over MCP (its tools: `get_status`, `set_glossary`, `set_options`,
`start_listening`, `stop_listening`, `read_transcript`). When its tools are there, read
[resources/beluga.md](resources/beluga.md) before the session: it says what you hand
Beluga in each phase.

## Other skills during a workshop

While this skill runs a workshop, it decides how a correction is handled:

- A correction to an existing process ("we skip that check now") is a proposal in the
  brief, and the facilitator's decision is its triage. Do not start `process-feedback`
  during the session. A correction still open at the wrap-up can be filed with it then,
  if the facilitator wants.
- `capture-process` and `new-process` do not run in a workshop: you do not interview the
  participants, and you do not scaffold a model the group is building live.
  [methods/bpmn.md](methods/bpmn.md) says what you take from `capture-process`.

## Rules that hold in every phase

- **The group decides, not you.** Something is confirmed when the group agrees or the
  person the brief names as deciding says so. One participant saying it is a statement.
  At `auto` you place statements too, and they stay statements until the group agrees.
- **Disagreement is a result.** When participants describe the same thing differently,
  record both views and mark the spot (the method file says how). Never pick one, never
  blend them.
- **Nothing invented.** A gap between two steps, an unnamed role, an unclear rule stays
  visible as an open point. A plausible guess in a model is read as fact later.
- **The transcript is unreliable.** Speech recognition breaks names and technical terms
  first. Check every term against the glossary in the brief. A passage you cannot read
  is an open point ("unintelligible at 14:32"), never a source. Do not smooth a passage
  into something that merely sounds right: a corrected sentence reads as certain.
- **Speakers only when the transcript names them.** A transcript without speakers, or
  with "Speaker 2", stays that way unless the facilitator maps it. A label for a channel
  or a device is no speaker either: "Me", "Others", "Room", or the name of the person
  whose laptop records. A recorder that labels channels puts everyone at one microphone
  under one label, so with one microphone in the room all its lines are unattributed
  unless the brief or the facilitator maps a label to one person. Do not attribute a
  statement to a person from its content alone. An unattributed line is never the person
  who decides speaking.
- **The participants' words.** Name things the way the group names them. A new term goes
  into the glossary; two words for one thing is a hint for the facilitator.
