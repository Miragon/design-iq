# Phase 1: Prepare

Done with the facilitator, before the session. The result is a brief both of you agree on
and a workspace the group can start in.

## 1. Agree the brief

Ask the facilitator, one topic at a time, and fill the template as you go:

1. **Goal.** What is settled at the end? What is deliberately left out? A goal like
   "model our sales process" is too wide: ask what decision or change the model is for.
2. **Participants.** Who is in the room, what do they speak for, and who decides when the
   group does not agree? Record roles ("Sales lead", "Billing clerk"), not names: the
   brief goes into the repository's history. If nobody decides, say so in the brief:
   open points then stay open.
3. **Notation.** Derive it from the question the workshop has to answer, and say why:

   | The workshop asks                                     | Notation                   |
   | ----------------------------------------------------- | -------------------------- |
   | What happens in this domain, and where does it hurt?  | Event Storming             |
   | How exactly does it run, who does what?               | BPMN                       |
   | By which rules is it decided?                         | DMN                        |
   | Where do we invest, what do we buy?                   | Wardley Map                |
   | How do we cut systems and teams?                      | Context Map, Team Topology |
   | Which activities create the value, in which order?    | Value Chain                |

   One session, one notation is the safe default. A second model in another notation is
   for a later session unless the facilitator asks for it.

4. **Models.** List what already exists on the topic (`list_models`, then read each
   candidate) and show the facilitator. A workshop that corrects an existing model starts
   from it, not from a blank one. Its corrections are proposals in the brief, not
   feedback reports (SKILL.md, Other skills during a workshop). Agree which models you
   may change directly at levels `model` and `auto`.
5. **Expectations.** Level of detail, the questions that must be answered, and what was
   left open last time (read the last session's **Open** list if the brief exists).
6. **Autonomy.** Explain the four levels in one sentence each and let the facilitator
   choose. `propose` is the careful start for a first session with you. `auto` lets the
   models grow while the group talks, which needs a live transcript; the group then sees
   every change you make at once, on the screen it looks at.
7. **Glossary.** Collect names of systems, products, roles and abbreviations. Take them
   from the existing models too. Ask which of them are English terms in a German
   conversation or the other way round: these are misheard most. A transcriber that takes
   a glossary gets this list before the session. With Beluga's tools you hand it over
   yourself ([resources/beluga.md](../resources/beluga.md)); otherwise the facilitator
   takes it in Beluga's window (**Take from a workshop brief**). The participants' names,
   which the brief does not hold, go into Beluga's glossary only, which stays on the
   facilitator's machine. Names the facilitator tells you reach your model provider on
   the way; to keep them off it, the facilitator types them in Beluga's window.
8. **Transcript and consent.** Where does the transcript come from, and does everyone
   taking part, in the room and on a call, know they are transcribed and that an AI
   assistant reads along? The audio can stay on the facilitator's computer, the
   transcript's text reaches the assistant's model provider. Record that the facilitator
   confirmed it. Without consent there is no transcript; you can still work from the
   facilitator's notes.
   Ask what the transcript's labels stand for: one person each, or a channel or a
   microphone with several people behind it. Ask whether names may be stored in the
   brief. The default is no: roles only, and the facilitator's name only if they agree.

Play the brief back in a few sentences and let the facilitator correct it.

## 2. Set up the workspace

Only what the brief names:

- **New models**: create each one empty, with its title. Do not pre-fill a model with what
  you expect the group to say. A pre-filled model anchors the discussion.
- **Existing models**: leave them as they are. Note their state in the brief (for a
  process: number of steps, lanes; for an Event Storming board: events, hotspots).
- **Board**, when the facilitator wants one: create a `.board` or extend the existing one.
  Put the workshop's models on it by their repository path, grouped by topic, with a note
  that states the goal. Read an existing board before changing it and keep every element
  that is there. A Markdown document cannot be shown on a board, and a note's link works
  only for a web address. So name the brief in a note by its repository path, as text.
- Validate every model you created or changed.

## 3. Hand over

Tell the facilitator in a few lines: where the brief is, which models and which board are
ready, the autonomy level, and what you need at the start of the session (the transcript
source running, the brief open next to the models). With Beluga's tools, say that you
start it yourself once the facilitator says so.
