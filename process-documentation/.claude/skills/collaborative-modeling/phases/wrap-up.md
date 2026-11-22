# Phase 3: Wrap up

At the end of the session, or afterwards from the full transcript. If you were not in the
session and only get the transcript now, go through it the way phase 2 describes at the
level `propose`, then continue here.

If you started Beluga, stop it when the facilitator ends the session
([resources/beluga.md](../resources/beluga.md)) and handle the last lines first.

## 1. Settle the proposals

Show the facilitator every proposal that is neither applied nor struck through, and get
a decision on each: accept, drop, or carry over. Apply and mark the accepted ones the way
[assist.md](assist.md) describes, and validate. A carried-over proposal goes into the
next session's expectations.

## 2. Play back

Give the facilitator a playback they can read to the group or send round, in the group's
own words and without notation terms:

1. what the group set out to settle (the goal from the brief),
2. what the models now say, as a short narrative per model,
3. what was decided today,
4. what is open, with both views where the group disagreed, and what is in the models
   but not yet confirmed by the group,
5. what is needed from whom before the next session.

Corrections to the playback are changes like any other: apply them by the level in force.
At `auto` the playback is where the group confirms what you placed: go through each model
in the group's words, put what it confirms under **Confirmed**, and change what it
corrects. What the playback leaves unconfirmed goes under **Open** as "in the model, not
yet confirmed by the group", with its time.

## 3. Record the open points

Every item under **Open** gets an owner, the role that settles it, written on its line as
"(owner: <role>)". Ask the facilitator for the owners you do not know.

The **Open** list in the brief is the record. When the Live Host offers todos
(`create_todo`), offer the facilitator to file the open points as todos as well, and file
them only when the facilitator agrees:

- one todo per open point, on the model it concerns, anchored to the element where there
  is one, with the owner and the transcript time in its text;
- roles, not names, and both views of a disagreement without saying who held which;
- decisions (DMN) and boards take no todos: their open points stay in the brief.

A correction to an existing process that stays open can also be filed with
`process-feedback`, when the facilitator wants that.

## 4. Close the log entry

Complete today's entry in the brief: **Confirmed** with where each point is in the
models, **Open** as recorded above, every proposal applied, struck through or carried
over, and the transcript time you read up to. Add new terms to the glossary. Under
**Expectations**, replace "carried over from the last session" with today's open points
and carried-over proposals, so the next session starts from them.

## 5. Check and release

- Validate every model in scope once more.
- Tell the facilitator what changed and is not yet released (`list_changes` on a Live
  Host). It lists every unreleased file of the repository, other people's edits
  included.
- A release is the facilitator's call: open the pull request only when asked, and only
  with the workshop's files among those `list_changes` reports (the brief, the board and
  the models in scope that changed), passed to `release_process` as `files`. A file
  without changes is refused. In a checkout, leave the changes uncommitted unless asked.
- On a read-only Live Host there are no todos and no release: hand the facilitator the
  text of today's log entry instead.

## 6. Report

A few lines: models changed, points confirmed, points open, and the suggested focus of
the next session. If the session showed that another notation is needed (a decision that
wants a table, a process hidden in an Event Storming board), say so as a suggestion for
the next brief. Do not start that model now.
