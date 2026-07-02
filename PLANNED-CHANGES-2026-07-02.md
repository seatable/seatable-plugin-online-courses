# Online Courses plugin — planned changes & findings (handoff 2026-07-02)

Notes written for a future session started **from this repo**. Companion to the
course-4 design memory (other project, key `…-online-course-4`). This plugin is the
**pilot for the "Online courses" plugin** (drives course 4; one plugin serves all 7
courses). Runner is **manifest-driven** (content + answer keys fetched per course,
not hardcoded).

## Key files (verified this session)

- `src/entry.tsx` — host entry: `registerPluginItemCallback` → `SeaTablePlugin.execute()`.
- `src/index.js` — dev entry (standalone, top-level URL).
- `src/app.tsx` — orchestrator: renders `<PluginPresets>` (left panel) + `<CustomPlugin>` (body)
  - `<PluginSettings>`. Shared state = `appActiveState`; `onSelectPreset(id, activeState)`.
- `src/components/custom-components/OnlineCourse/index.tsx` — the **runner** (course page /
  exercise banner). Loads a `manifest`, navigates `steps`, grades, persists progress.
- `src/components/template-components/PluginPresets/index.tsx` — the **left panel** (flat
  `pluginPresets.map(...)` → `<PresetItem>`).
- `src/utils/custom-utils/courseContent.ts` (manifest), `grader.ts` ([GRADE]),
  `courseProgress.ts` (resume: current step per course).

## ⚠️ Git state

The **course plugin is entirely uncommitted** (working-tree only; committed branch
`audit-v0` is a _different_ plugin — TablesAudit/PerformanceAudit). **Commit it on a
dedicated branch** to avoid losing the work.

---

## 1. Deep-link via URL (`qid`) — DEAD, decided. No more work on the URL path.

**Intended mechanism (confirmed, correct):** `OnlineCourse/index.tsx` reads a `qid`
param (4 alphanum, regex `QID_PATTERN`) via `URLSearchParams(window.location.search)` in
`getQidFromUrl()`, used by `resolveInitialStepId()` (deep-link > resume > first step).

**Why it doesn't work in production (root cause):** two webpack entries.

- **Dev** (`npm start` → `src/index.js`): plugin runs at the browser's top-level URL, so
  `location.search` = the address bar → `qid` present. _This is the "it worked before"._
- **Host** (`src/entry.tsx` → `registerPluginItemCallback`): SeaTable's dtable-web SPA owns
  the URL. It reads `tid`/`vid`/`plugin-name`, then **rewrites the URL and drops unknown
  params (incl. `qid`) BEFORE the plugin script is even evaluated.**

**Tested this session:** added `console.log(window.location.href)` at module-eval AND in
`execute()`. Result: `qid` absent from **both** — with both `?qid=…` and `#qid=…`
(query _and_ hash are stripped). Logs have been **removed** (`entry.tsx` is clean again).

**Conclusion:** the URL is a dead end. Do **not** re-attempt query/hash. If deep-link is
ever needed again, use `pluginDataStore`/preset settings — **but the real navigation
solution is the presets tree below (§2), which makes deep-link unnecessary.** Non-blocking:
without `qid`, the runner resumes / opens the first step.

---

## 2. Left panel → navigation TREE (main planned change)

**Goal:** turn `PluginPresets` (flat list) into a **2-level tree**: course (expand/collapse)
→ exercises (indented, clickable). Clicking a step navigates the runner. This also
**replaces the lost `qid` deep-link** (navigate by clicking, no URL).

**Feasible with no blocker** — the panel is 100% plugin-controlled React (SeaTable imposes
nothing on its content).

**Approach ("1 preset = 1 course", least disruptive):** keep presets for level 1 (courses);
under each _expanded_ preset, render an indented list of that course's `manifest.steps`
(level 2). Add per-course expand/collapse state. Reuse `PresetItem` for the course row;
add a small "steps list" component beneath.

**The real work = two "lift state up" refactors:**

1. **Navigation.** `OnlineCourse` currently owns `stepId` internally (`useState` + URL).
   Lift `courseId`/`stepId` up to `App` (source of truth); pass `onSelectStep(courseId,
stepId)` to the panel and `stepId` as props to the runner (runner becomes _controlled_).
   The runner's `goNext`/`goPrev` should also go through `App` to stay in sync with the tree.
2. **Steps per course.** The `manifest` is loaded _inside the runner_, but the panel needs
   the step list. Load/lift the manifests to `App` (or a light per-course index).

**Files:** `app.tsx` (state + wiring), `PluginPresets/index.tsx` (+ `PresetItem`) for the
tree render, `OnlineCourse/index.tsx` (become controlled), `courseContent.ts` (manifests /
index).

**Timing:** after the course draft — this is plugin ergonomics, not course content.

---

## 3. "Load the example" fallback (AI safety net) — feature to ADD, plugin-side

Course-4 decision: when the AI OCR→JSON extraction misfires, the learner must never be
blocked. The fallback **lives in the plugin** (not a native base button+script — keeps the
base clean and showcases a plugin capability). The plugin should expose an action that
**injects the canonical example rows** into the `Ordered quantities` table on demand.
Grading targets **"rows exist + validated", never AI success.**

---

## 4. What the plugin owns for course 4 — [GRADE] + fallback (updated 2026-07-02)

Current terminology: tables `Products` / `Documents` / `Line items`; stock column `Stock`.

**Staging is now mostly handled by imports, not the plugin.** The learner imports the base
from a `.dtable` (Step 1) and the delivery lines from a CSV (Step 2); the delivery-note PDF
ships inside the `.dtable`. So the plugin does NOT build the whole scenario. What it owns:

- **[GRADE]** the data deltas (`grader.ts` scores DATA, not config).
- **"Load the example" fallback** (§3) — inject the canonical `Line items` if the AI
  extraction misfires (Step 5).
- Optionally a **reset** to replay a step.

**[GRADE] points, mapped to the current 9-step split:**

- **Step 2 — Import & link** → imported lines are linked to their `Product` and `Document`.
- **Step 3 — Receive & stock** → `Stock` updated on the linked product (status-aware:
  `As expected`→`Qty`, `Missing`/`Damaged`→0, else `Received qty`).
- **Step 4 — Close & alert** (NEW) → a `Reviewer` is assigned when `Review needed`. This is
  also the **showcase exercise** of §5 (grade-by-attribution: last-modifier = `Automation Rule`).
- **Step 5 — AI extracts lines** → lines exist and are validated (grade the RESULT, never the
  AI's success; the "Load the example" fallback covers misfires).
- **Step 8 — API inbound** → an `Order` row is appended via `append_rows`.

(Steps 6 webhooks / 7 n8n are [GUIDE] — fire-and-look, not graded.)

---

## 5. "Open-ended" grading via the op-log (showcase feature to prototype)

A richer grading mode than "cell equals X". Example task: _"Set up an automation that adds
a colleague to the `Reviewer` column when at least one line of the delivery has a problem."_
On verify, the plugin reads the **op-log / row history** and checks that `Reviewer` was
filled **by an automation** (not a manual/script/API edit) **and** that the business
condition held (`Review needed` was true). This grades the _method_, not just the state —
a strong selling point for the plugin.

**Feasibility CONFIRMED (2026-07-02).** An automation-driven edit shows up as
**`Automation Rule`** in both the **last-modifier column** and the **row activity log**
(≠ a member name) — so it IS distinguishable from a manual edit. The plugin already probed
edit attribution in the dev-benches ("authored-write / live-modify" in
`OnlineCourse/index.tsx`). **To build the graded exercise:** read the target row's
last-modifier (or its activity log) and check it equals `Automation Rule`, plus the business
condition (`Review needed` true). Verify which API surface exposes last-modifier / row
activities to the plugin's read path (`sdkRead.ts`).

**Recommendation:** make this ONE showcase exercise, not the model for all (costlier, more
fragile). **Fallback** (now just a safety net, not plan A): grade the result only (`Reviewer`
filled AND `Review needed` true) — less strict, still far better than a cell check.

---

### Pointers

- Course-4 pedagogical thread & locked decisions: memory of the `…-online-course-4` project.
- This plugin's own memory key: `-home-bennhatton-Dev-seatable-seatable-plugin-online-courses`.
