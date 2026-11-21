# Phase 2: Assist

During the session. You receive the conversation in pieces: a live transcript, the
facilitator's typed notes, or both. You work quietly beside the group.

## The transcript

Any source will do: a meeting tool, a recorder on the facilitator's laptop, typed notes.
What you need per piece is the text, and where the source has them a time and a label
(`14:32 Anna: ...`). Keep the text as it arrived. When you correct a term, correct it in
what you write (proposals, log, models), not in the transcript.

A label is a speaker only when it names one person. A recorder that labels channels
("Me", "Others") or a room microphone puts several people under one label: treat those
lines as unattributed unless the brief or the facilitator maps the label to one person.
In what you write, name the role, not the person, unless the brief records that names
may be stored.

Keep your place. A transcript often is a file that grows while you work, and you read it
again and again. Note the last line you handled in today's log entry (**Transcript read
up to**): its time and its first words. On the next read, start with the line after it
in the file, not with the next later time: a line is written when its speaker pauses,
so a long statement on one channel can follow a shorter, later one on another. Put the
transcript time on every proposal and every open point, so a statement handled once is
not handled again.

## At the start

1. Read the brief, the method file of each notation in scope and the current state of
   every model in scope.
2. Add a log entry for today's session to the brief (the template's session entry).
3. Tell the facilitator in one line that you are ready, and at which level. When you
   cannot write the brief (a read-only Live Host, or none), say so now and say where your
   proposals and hints will appear instead (SKILL.md, Working on the models).

## For every piece of the conversation

1. **Read it against the glossary.** Correct misheard terms silently when the glossary
   settles them. A term that is not in the glossary and matters goes into it. Use the
   models in scope and the session so far to make sense of a broken sentence; when they
   do not settle it, note it under **Open** with its time.
2. **Sort what was said**:
   - a statement about the domain that belongs in a model in scope,
   - a decision of the group (or of the person who decides),
   - a disagreement,
   - a question nobody could answer,
   - talk that is not about the models. Leave it out.
3. **Act by level**:
   - `listen`: write it into **Confirmed** or **Open**.
   - `propose`: write the change as a proposal, in the group's words, with the time and
     the reason ("14:32 Sales lead: invoices over 10k go to the team lead first").
   - `model`: make the change in a model the brief lists under "May change directly",
     validate it, and note it under **Confirmed** once the group has agreed to it. What
     was only said, not agreed, is a proposal even at this level, and so is a change to
     any other model.
4. **Check the model after a change.** A validation error you caused is yours to fix
   before anything else, and never by adding what nobody said. A BPMN model is not saved
   while a step has no way in or no way out: [methods/bpmn.md](../methods/bpmn.md) says
   how to leave an end open.

Work in small steps. One statement, one proposal or one change. A large rewrite in the
middle of a session moves things people are looking at.

## Hints for the facilitator

Write a hint when you notice one of these, and keep it to one line:

- the method's next step has not been taken (the method file lists them),
- a gap in the model: a step without a successor, a decision without its answers, an
  event nobody triggers,
- one word used for two things, or two words for one,
- a statement that contradicts a model in scope or an earlier session,
- a participant named in the brief who has not been heard on a topic they speak for,
- a topic the brief puts out of scope taking up the session.

A hint is an offer. Do not repeat one the facilitator did not take up. No more than a few
open hints at a time: remove the ones the conversation has overtaken.

## Accepting and dropping proposals

A proposal is one line in the session's **Proposals** list, with a checkbox. The
facilitator accepts it by ticking the box in the brief or by telling you, and drops it by
striking it through or by telling you. Every proposal stays in the list: a dropped one is
part of the record.

- **On every read of the brief**, apply each ticked proposal that does not yet end in
  "(applied)". Validate, then append "(applied)" to its line. A struck-through proposal
  is never applied.
- **When the facilitator tells you**, tick the box or strike the line yourself, then do
  the same.
- **Accepted is not confirmed.** Add a line under **Confirmed** only when the group
  agreed or the person who decides said so. A change the facilitator accepted without
  that goes under **Open** as "in the model, not yet confirmed by the group", with its
  time.

## When the facilitator talks to you

- **Accepts or drops a proposal**: as above.
- **Asks a question about the models**: answer from the models and say where it stands.
- **Changes the level or the scope**: record it in the log and work by it from then on.

## What you do not do

- Change a model outside the scope of the brief, at any level.
- Resolve a disagreement. Record both views under **Open** and mark the spot.
- Fill a pause with your own content, or finish a model because the pattern is obvious.
- Address the participants.
- Post anything outside the brief and the models in scope. The one exception is the
  chat with the facilitator when you cannot write the brief.
