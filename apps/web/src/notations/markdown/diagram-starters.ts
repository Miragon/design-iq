/**
 * The starter diagrams "Insert diagram" offers in the Markdown source: one
 * small, valid Mermaid diagram per common type, on one example (an order on
 * its way to cash) and in the modeling conventions of the platform: tasks
 * as verb and object, events as object and past participle, decisions as
 * questions. A starter is something to edit, not a template to fill in: it
 * draws as inserted, and the cursor selects the label to write first.
 *
 * Pure data, in the source tooling's lazy chunk. test/diagram-starters.test.ts
 * parses every starter with the mermaid apps/web pins and runs the
 * validator's check of a document's diagrams over it, so a mermaid bump that
 * breaks one fails there.
 */

export interface DiagramStarter {
  /** stable id: the menu entry's and the editor action's */
  id: string;
  /** the menu entry, e.g. "Flowchart" */
  label: string;
  /** a line under the label: what the diagram shows */
  description: string;
  /** the Mermaid text, the fence's content: every line ends with a line break */
  body: string;
  /** a text on one line of the body: the cursor selects its first occurrence */
  select: string;
}

/** the lines of a body, each with its line break */
const body = (...lines: string[]): string => lines.map((line) => `${line}\n`).join("");

export const DIAGRAM_STARTERS: readonly DiagramStarter[] = [
  {
    id: "flowchart",
    label: "Flowchart",
    description: "Steps and decisions",
    body: body(
      "flowchart LR",
      "  received([Order received]) --> stock{In stock?}",
      "  stock -->|yes| ship[Ship the goods]",
      "  stock -->|no| reorder[Reorder the goods]",
      "  reorder --> ship",
      "  ship --> shipped([Order shipped])",
    ),
    select: "Order received",
  },
  {
    id: "sequence",
    label: "Sequence",
    description: "Messages between participants over time",
    body: body(
      "sequenceDiagram",
      "  actor Customer",
      "  participant Shop",
      "  participant Payment as Payment provider",
      "  Customer->>Shop: Place the order",
      "  Shop->>Payment: Charge the card",
      "  Payment-->>Shop: Payment confirmed",
      "  Shop-->>Customer: Send the confirmation",
    ),
    select: "Place the order",
  },
  {
    id: "class",
    label: "Class",
    description: "Classes, their attributes and relations",
    body: body(
      "classDiagram",
      "  class Customer {",
      "    +String name",
      "    +placeOrder() Order",
      "  }",
      "  class Order {",
      "    +String number",
      "    +Date placedAt",
      "    +total() Money",
      "  }",
      "  class OrderLine {",
      "    +String product",
      "    +int quantity",
      "  }",
      '  Customer "1" --> "*" Order : places',
      '  Order "1" *-- "1..*" OrderLine : contains',
    ),
    select: "places",
  },
  {
    id: "state",
    label: "State",
    description: "The states of one thing and what moves it on",
    body: body(
      "stateDiagram-v2",
      "  [*] --> Placed",
      "  Placed --> Paid : Payment received",
      "  Placed --> Cancelled : Order cancelled",
      "  Paid --> Shipped : Goods sent",
      "  Shipped --> [*]",
      "  Cancelled --> [*]",
    ),
    select: "Payment received",
  },
  {
    id: "entity-relationship",
    label: "Entity relationship",
    description: "Data entities and how they relate",
    body: body(
      "erDiagram",
      "  CUSTOMER ||--o{ ORDER : places",
      "  ORDER ||--|{ ORDER_LINE : contains",
      '  PRODUCT ||--o{ ORDER_LINE : "is ordered in"',
      "  CUSTOMER {",
      "    string name",
      "    string email",
      "  }",
      "  ORDER {",
      "    string number",
      "    date placedAt",
      "  }",
    ),
    select: "places",
  },
  {
    id: "gantt",
    label: "Gantt",
    description: "A plan of tasks over time",
    body: body(
      "gantt",
      "  title Rollout plan",
      "  dateFormat YYYY-MM-DD",
      "  section Prepare",
      "    Write the concept :concept, 2027-01-04, 5d",
      "    Review it with the team :review, after concept, 3d",
      "  section Roll out",
      "    Train the users :training, after review, 4d",
      "    Go live :milestone, live, after training, 0d",
    ),
    select: "Rollout plan",
  },
  {
    id: "c4-context",
    label: "C4 context",
    description: "A system, its users and its neighbours",
    body: body(
      "C4Context",
      "  title Order handling",
      '  Person(customer, "Customer", "Orders goods online")',
      '  System(shop, "Web shop", "Takes the orders and tracks them")',
      '  System_Ext(payment, "Payment provider", "Charges the card")',
      '  Rel(customer, shop, "Places orders")',
      '  Rel(shop, payment, "Charges the card")',
    ),
    select: "Order handling",
  },
  {
    id: "mindmap",
    label: "Mindmap",
    description: "Ideas branching out from one topic",
    body: body(
      "mindmap",
      "  root((Order to cash))",
      "    Order",
      "      Received",
      "      Checked",
      "    Delivery",
      "      Packed",
      "      Shipped",
      "    Payment",
      "      Invoiced",
      "      Paid",
    ),
    select: "Order to cash",
  },
];
