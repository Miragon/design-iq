# Method: Event Storming

An Event Storming board (`.storm`) tells what happens in a domain as a line of events,
left to right in time. The group builds it in steps. Know which step the group is in:
most of your hints are "the next step has not been taken yet".

Read an existing `.storm` of the repository before you write one, and write in its style.
The format is below.

## The steps of a session

1. **Collect events.** Everything that happens, as a fact in the past: "Order placed",
   "Payment failed". Unsorted, with duplicates, no discussion yet.
   Listen for: verbs in the past tense, "and then", "after that", "as soon as".
2. **Order them in time.** Left to right. Duplicates merge, gaps show.
   Listen for: "before that", "that only happens when", two people ordering the same
   events differently (a hotspot, not an error).
3. **Mark what hurts.** Hotspots: disagreement, an unknown, a known problem.
   Listen for: "it depends", "nobody really knows", "that always goes wrong", silence
   after a question.
4. **Add what causes each event.** A command (someone decides to do something) and the
   actor who gives it, or a policy ("whenever X, then Y") that reacts to an earlier event,
   or an external system.
   Listen for: "the customer clicks", "the clerk approves", "automatically", "the system
   then", "whenever".
5. **Add what is needed to decide.** Read models: the information an actor looks at
   before giving a command.
   Listen for: "she checks the", "you can see in the list", "based on the report".
6. **Group around what keeps the rules.** Aggregates, and later the boundaries between
   areas. Only at design level, and only when the brief asks for that depth.

The brief's level of detail says where to stop. A big-picture session ends after step 3.

## The `.storm` format

One statement per line. `[x, y]` is the place on the board in pixels, x first: x is the
time line, left to right.

```
title Order to Cash
level design
event Order Placed [620, 300]
command Place Order [240, 300]
actor Customer [80, 300]
policy When order placed, ship it [800, 300]
external Payment Provider [420, 520]
readmodel Order Status [620, 120]
aggregate Order [420, 290] (id agg_order)
hotspot Double payment on retry? [620, 520] (on Order Placed)
note Design-level session: checkout flow [80, 80]
Customer -> Place Order
Place Order -> #agg_order
#agg_order -> Order Placed
Order Placed -> When order placed, ship it
```

- **Element types**: `event`, `command`, `actor`, `aggregate`, `policy`, `readmodel`,
  `external`, `hotspot` (the stickies) and `note`. Write no other keyword.
- **Level**: `level big-picture`, `level process` or `level design`, after the brief's
  level of detail.
- **Arrows**: `A -> B`, between stickies only (a note takes none), with an optional
  label after a semicolon (`A -> B; async`). An arrow names its ends by their text, and
  a text that appears twice means the first element with it. Give a repeated text an id
  (`(id order_2)`) and point at it with `#order_2`.
- **Pinning**: `(on <element>)` pins an actor, a hotspot or a note to an event, a command,
  an aggregate, a policy, a read model or an external system.
- **Layout**: keep the existing board's rows. Events on one line, what causes an event
  to its left, read models above, external systems and hotspots below.

`validate_model` accepts any `.storm` text: a misspelled keyword, an arrow to a text
that is not on the board or an arrow from a note is dropped without an error. After
every change, read the board back with `get_view`: a new sticky must be in
`detail.timeline` with the type you meant, and `stats.arrows` must have grown by the
arrows you wrote. A note is not on the timeline: check that `stats.notes` grew.

## How statements become elements

| Someone says                                    | Element                                   |
| ----------------------------------------------- | ----------------------------------------- |
| something happened, a fact                      | event, named object + past participle     |
| someone decides to do something                 | command, named verb + object, plus actor  |
| "whenever A, then B" without a person deciding  | policy, named in the group's sentence     |
| a system outside the group's control acts       | external system                           |
| someone looks something up to decide            | read model                                |
| disagreement, unknown, pain                     | hotspot, phrased as the open question     |
| context that is no element (scope, assumption)  | note                                      |

Name every element in the group's words. One event per fact: "Order placed and paid" is
two events.

## Marking

- **Disagreement or unknown**: a hotspot pinned to the element it concerns, phrased as
  the question ("Double payment on retry?"). Both views go under **Open** in the brief.
- **Proposals** (level `propose`): describe the element and where it goes ("event
  'Invoice sent' after 'Order shipped'"). Do not place it.
- **Placing** (level `model` or `auto`, or an accepted proposal): keep the time line. Put
  a new element where it belongs in the order and leave what the group placed where it
  is. Draw the arrows the group named, in the format above.

## What a good board looks like at the end

- Every event is a past fact, and the line reads as a story from left to right.
- From step 4 on: every event has a cause (a command with an actor, a policy or an
  external system). An event without one is a hint, or an open point at the end.
- Every hotspot is phrased as a question and appears under **Open** in the brief.
- No element the group did not say.

## Typical hints in an Event Storming session

- "No event yet between 'Order placed' and 'Order shipped': what happens in between?"
- "'Customer' and 'Client' are both used: the same?"
- "Three events about payment, no one from Finance heard yet."
- "'Check stock' is on the board as an event. A command, or 'Stock checked'?"
- "The group has been in step 4 for one part only; the right half has no causes yet."
