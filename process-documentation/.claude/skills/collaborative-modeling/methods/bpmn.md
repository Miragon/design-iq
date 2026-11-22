# Method: BPMN

A BPMN process (`.bpmn`) says how the work runs: who does what, in which order, and where
it forks. In a workshop the group builds or corrects it step by step while you listen.

## What you take from capture-process

The `capture-process` skill interviews one process owner. In a workshop you take two
parts of it and nothing else:

- **What to listen for**: what its interview protocol collects in phases 1 to 3. The
  trigger and the outcome, the happy path step by step with who does each step, every
  decision as a closed question with its answers, every handoff between roles, the
  exceptions and how they are handled, and the sub-process candidates (a step that
  turns into steps of its own).
- **Its conventions**: tasks verb + object, events object + past participle, gateways
  as questions, lanes for roles or teams, a sub-process as its own `.bpmn` called by a
  call activity, and a text annotation "(unconfirmed)" on an element nobody confirmed.

You do not run its interview. You ask the participants nothing: a question goes to the
facilitator as a hint. You do not hand over to `new-process`: it writes a whole model as
a file, and the group is building this one live.

## The steps of a session

1. **Trigger and outcome.** What starts the process, and what holds at the end.
   Listen for: "when", "as soon as", "it starts with", "then we are done".
2. **Happy path.** The steps in order, each with who does it.
   Listen for: "then", "after that", "next", "who does that", "that is with Sales".
3. **Decisions.** Every fork as a question and its answers.
   Listen for: "if", "unless", "it depends", "either or", "only when".
4. **Handoffs.** Where another role or team takes over.
   Listen for: "hands it to", "passes on", "then it goes to".
5. **Exceptions.** What goes wrong at a step, and what happens then.
   Listen for: "if that fails", "sometimes", "when the customer does not answer".

Most of your hints are "the next step has not been taken yet".

## How statements become elements

| Someone says                                   | Element                                                  |
| ---------------------------------------------- | -------------------------------------------------------- |
| what starts it                                 | start event, object + past participle                    |
| someone does something                         | task, verb + object, in the lane of who does it          |
| a system does it on its own                    | service task                                             |
| "if", "it depends", "either or"                | exclusive gateway, named as the question                 |
| an answer to that question                     | an outgoing flow of the gateway, named with the answer   |
| another team takes over                        | the next task in that team's lane                        |
| a step that is a process of its own            | a sub-process candidate: a hint, not a new model         |
| what holds at the end                          | end event, object + past participle                      |
| something goes wrong at a step                 | an exception path, only as far as the group describes it |
| disagreement, unknown, "nobody really knows"   | text annotation on the element, phrased as the question  |

## Open ends

A BPMN model is saved only while every step has a way in and a way out: a step without
an incoming or an outgoing flow is a validation error, and the save is refused. Only the
start event of an empty new model is exempt. A group seldom tells a process from start to
end in one go, so:

- Place a step only after the element the group said it follows. A step whose
  predecessor nobody named stays a proposal.
- Where the group stopped, end the path with an end event without a name (a name would
  claim an outcome nobody stated) and attach the text annotation "(unconfirmed)" to it.
  List it under **Open** with its time ("What follows 'Check credit limit'? 14:32").
- When the group names what really comes next, replace that end event and its
  annotation.
- Never add a step, a branch or a named end only to get past the check.

A gateway with one answer named so far has one outgoing flow. That saves; the missing
answers are a hint, then an open point.

## Changing the model

- When the Live Host offers `get_process_outline` and `edit_process`, read around the
  spot with the outline and make each change as one `edit_process` call. It keeps the
  diagram in step and lays out what it changes.
- Otherwise read the XML, change the process and its diagram together (every flow node
  needs its shape, every flow its edge) and save it.
- Do not redraw the whole diagram during a session (`layout_process` with `redraw`):
  people are looking at it.

## Marking

- **Proposals** (level `propose`): name the element, its lane and where it goes ("task
  'Check credit limit' in lane Sales, after 'Order received'").
- **Disagreement or unknown**: a text annotation on the element it concerns, phrased as
  the question. Both views go under **Open** in the brief.
- **Placing** (level `model` or `auto`, or an accepted proposal): keep what the group
  placed where it is. Add the new element where the group put it in the order.

## What a good model looks like at the end

- One start event. Every path ends in an end event, and every unnamed one carries
  "(unconfirmed)" and appears under **Open**.
- Every task is named verb + object and sits in the lane of who does it.
- Every gateway is a question, and each of its flows is named with an answer.
- No element the group did not say.

## Typical hints in a BPMN session

- "'Check credit limit' has no lane yet: who does it?"
- "'Credit approved?' has only the 'yes' path: what happens on 'no'?"
- "The path after 'Send invoice' ends open: is the process done there?"
- "'Order' and 'Request' are both used for the same document?"
- "Three steps by Finance, nobody from Finance heard yet."
