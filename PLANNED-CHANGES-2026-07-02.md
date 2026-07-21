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
- **Step 4 — Reviewer assigned by automation when `Review needed`** (`au01`, `automation-set`) ✅.

## Outstanding grade points

- **Step 2 (optional corroboration)** — after the import runs, each imported `Line items`
  row has its `Product` **and** `Document` links filled (the data effect of the automation).
  A `cells`-style rule can't assert "link non-empty" per-row generically yet — needs a small
  grader addition or a fixed sample row.
- **Step 3 — Receive & update stock** → `Products.Stock` increased by the received qty on
  validated lines. Status-aware: `As expected`→`Qty`, `Missing`/`Damaged`→0, else
  `Received qty`. (Script-driven; grade the resulting `Stock` value.)
- **Step 5 — AI extracts lines** → `Line items` rows exist and are validated (one per
  product). Grade the RESULT, never the AI's success — the `le02` "Load the example" fallback
  covers misfires.
  ⚠️ **Caveat (course-side):** the Step-5 AI script writes `Document reference = 'DN'+delivery`,
  which differs from the `Documents.Identifier` the Step-2 link compares against → AI-created
  lines may NOT auto-fill their `Document` link under that rule. A canonical-key fix is pending
  course-side; don't build Step-5 grading on the assumption the link always fills.
- **Step 8 — API inbound** → an inbound `Line items` row is appended via `append_rows`.

(Steps 6 webhooks / 7 n8n are `[GUIDE]` — fire-and-look, not graded.)

## Pointers

- Course-4 pedagogical thread & locked decisions: memory of the `…-online-course-4` project.
- This plugin's own memory key: `-home-bennhatton-Dev-seatable-seatable-plugin-online-courses`.
