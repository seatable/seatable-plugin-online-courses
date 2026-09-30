# Online Courses plugin — outstanding [GRADE] points (Course 4)

Trimmed 2026-07-21. The original handoff's other sections are **done** and dropped:
§1 `qid` URL deep-link (dead end — decided, dead code removed), §2 nav-tree + controlled
runner, §3 "Load the example" AI fallback (`le02`), §5 op-log open-ended grading
(`opLogGrade.ts` + `au01`). What remains is the rest of §4: the per-step grade rules that
were "specs to detail later".

Authored base `Warehouse`; tables `Products` / `Documents` / `Line items`. Grade rules live
in the manifest (`courseContent.ts`); `grader.ts` scores DATA (cells), `opLogGrade.ts` /
`automationGrade.ts` score method/automation.

## Done (for context)

- **Step 2 — automation structure** (`am01`, `automation-rule` grade) ✅.
- **Step 2 — "Watch it work" link corroboration** (`CourseStep.watch` + `watchAutomation.ts`) ✅
  (2026-08-05). Once the rule passes its config grade, the plugin writes the delivery note's
  three lines into `Line items` (refs `8004400007203`/`9300605048454`/`0850210008934`, qty
  24/60/36, `Document reference` = `INT-001`) and polls the rows it just created until the
  learner's own rule has filled `Product` **and** `Document`. Solves the corroboration point
  below without a generic grader rule: it tracks the created row `_id`s by diffing the table
  around the append, so it can never "confirm" links on pre-existing rows.
- **Step 4 — Reviewer assigned by automation when `Review needed`** (`au01`, `automation-set`) ✅.

## Outstanding grade points

- **Step 3 — Receive & update stock** → `Products.Stock` increased by the received qty on
  validated lines. Status-aware: `As expected`→`Qty`, `Missing`/`Damaged`→0, else
  `Received qty`. (Script-driven; grade the resulting `Stock` value.)
- **Step 5 — AI extracts lines** → `Line items` rows exist and are validated (one per
  product). Grade the RESULT, never the AI's success — the `le02` "Load the example" fallback
  covers misfires.
  ⚠️ **Caveat (course-side):** the Step-5 AI script writes `Document reference = 'DN'+delivery`,
  which differs from the `Documents.Delivery reference` the Step-2 link compares against → AI-created
  lines may NOT auto-fill their `Document` link under that rule. A canonical-key fix is pending
  course-side; don't build Step-5 grading on the assumption the link always fills.
- **Step 8 — API inbound** → an inbound `Line items` row is appended via `append_rows`.

(Steps 6 webhooks / 7 n8n are `[GUIDE]` — fire-and-look, not graded.)

## Pointers

- Course-4 pedagogical thread & locked decisions: memory of the `…-online-course-4` project.
- This plugin's own memory key: `-home-bennhatton-Dev-seatable-seatable-plugin-online-courses`.
