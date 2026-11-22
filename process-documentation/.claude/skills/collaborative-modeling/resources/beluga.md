# Working with Beluga

Beluga transcribes a meeting on the facilitator's computer: the microphone and, if wanted,
what the computer plays (the other side of an online meeting). It writes one line per
utterance, `HH:MM:SS Label: text`, into a file on that computer. An assistant on the same
computer drives it over MCP once the facilitator has turned on **Agent access** in
Beluga's window. When its tools fail to connect, Beluga is not running or Agent access is
off: tell the facilitator.

The audio stays on the computer. The lines you read reach your model provider like any
other text, which the consent in the brief covers (phase 1, step 8).

## Before the session

1. `get_status`. When `modelInstalled` is false, the facilitator downloads the model in
   Beluga's window. Parakeet (the default) takes a glossary, Whisper does not.
2. `set_glossary` with the brief's glossary (its **Term** column), `mode` `replace`.
   Participants' names the facilitator tells you go in with `mode` `add`, and nowhere
   else: not into the brief, not into a model. They reach your model provider on the way;
   to keep them off it, the facilitator types them in Beluga's window instead. Once the
   model is downloaded, the answer's `notListenedFor` names entries Beluga cannot listen
   for (a digit, a slash, a rare letter). Tell the facilitator in one line; they stay in
   the brief, and you correct them in what you write.
3. `set_options` for what the brief says about the transcript: `systemAudio` for an
   online meeting, `labels` for the two channels (say `mic` "Room" when the computer
   sits in the room, `system` "Remote" for the other side of a call). Record the labels
   under **Transcript labels** in the brief. A label is a channel, never a person.

## Starting

Call `start_listening` only when the brief records that everyone agreed to the
transcription and the facilitator says to start. Pass its `notice` (a missing permission,
say) and its `notListenedFor` to the facilitator. The first start on a Mac asks the person
at the computer for permission, and the call waits for that. While a model downloads,
Beluga does not start.

## During the session

Read with `read_transcript`, the way [assist.md](../phases/assist.md) describes in A live
transcript you can wait on:

- `after` and `transcript`: the `through` and the `transcript` of the last answer; `after`
  0 on the first read (line 1 is Beluga's header, not talk). Each session writes a new
  file, and with the last `transcript` given Beluga reads a new one from its start. When
  the answer's `transcript` is another file than before, a new session began: its line
  numbers start again at 1.
- `wait`: 30. `quiet`: 3. It answers once nobody has spoken for 3 seconds, or after 30
  seconds with what has come, possibly nothing. Raise `quiet` to 5 or 8 when the rounds
  come faster than the group thinks, lower it when the models lag too far behind.
- `more` true: read again at once with the new `after`, before the round.
- `phase` `idle`: Beluga has stopped, because the facilitator pressed Stop (for a break,
  too) or because of an error. Read until `more` is false and tell the facilitator in one
  line that the transcript stopped. Wrap up only once they say the session is over.
  Otherwise keep reading as before: while Beluga is stopped, a waiting read waits for the
  next session and then reads its file from the start.

Put the file name and the line number of the last line you handled into **Transcript
read up to**, with its time and first words. After a restart of yours, go on from there
with that file as `transcript`.

A term that comes up and matters goes into the brief's glossary and, with `set_glossary`
`mode` `add`, into Beluga: it listens for it from its next line on. A term Beluga keeps
mishearing ("Kamunda" for Camunda) belongs there too.

Every ten rounds or so, `get_status`. When `behindSeconds` is above 60, tell the
facilitator once: you are reading talk from a minute ago, and the computer is too slow for
the model (fewer programs, or Parakeet instead of Whisper next time).

`set_options` is refused while Beluga listens: a session keeps the options it started
with. The glossary can change at any time.

## At the end

When the facilitator ends the session, call `stop_listening`. It answers once Beluga has
written everything it heard. Read the last lines with `read_transcript`, handle them, then
continue with the wrap-up.

The transcript file stays on the facilitator's computer, and its path is in every answer.
Do not copy it into the repository: the brief's log is the record.
