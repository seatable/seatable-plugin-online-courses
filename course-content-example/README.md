# Course content served to the plugin

The contract between the plugin and a content host: what the host serves, and what the
plugin expects to find there. Types and field-by-field documentation are in
`src/utils/custom-utils/courseContent.ts` (`CourseStep`, `CourseManifest`) and
`src/utils/custom-utils/grader.ts` (grade rules) — this file is the overview.

> **Status — not wired, by decision.** The team chose bundled content (2026-10-06):
> `loadAllCourses()` returns `buildAllFallbackManifests()`, and `fetchManifest()` /
> `fetchStepHtml()` exist but nothing calls the remote path. The `USE_REMOTE_CONTENT`
> flag is declared, not read: flipping it changes nothing until `loadAllCourses()`
> reads it. The proof of concept that wired it is kept on the `poc-academy` branch.

## Bundled content: logic and words (current)

Every course ships inside the plugin, split in two:

- **logic** — `src/utils/custom-utils/courseContent.ts`: the steps and their order, the
  grade rules, what the plugin writes into a base. Written once, for every language.
- **words** — `src/content/<courseId>/manifest.<lang>.json`: titles, bodies, captions,
  hints and messages, keyed by step id. Every file has the shape of `manifest.en.json`
  (see `courseTexts.ts`); a text missing from a language falls back to English. A
  `{placeholder}` is filled from the logic (e.g. `{apiDeliveryReference}` in Course 4).

The plugin picks the language SeaTable is displayed in. `npm run check-texts` compares
each translation with English: unknown keys and changed placeholders are errors, missing
texts are only counted (they show in English).

The host layout below is the earlier, remote design, kept for if the team comes back to it.

## Layout on the host

```
<CONTENT_BASE>/                 ← CONTENT_BASE in courseContent.ts
└── <courseId>/                 ← one folder per course: course-3, course-4, …
    ├── manifest.json           ← the course: ordered steps
    └── <fragment>.html         ← optional: step bodies referenced by `contentUrl`
```

The plugin reads `${CONTENT_BASE}/${courseId}/manifest.json`, then, for a step with no
inline `html`, `${CONTENT_BASE}/${courseId}/${step.contentUrl}`.

`courseId` is the id of an entry in `COURSES` (courseContent.ts), which stays in the
plugin: it holds the course list, names, access (`active` / `external`) and intro text.
The `welcome` tour is plugin UI, not course content, and is not fetched.

## manifest.json

```jsonc
{
  "courseId": "course-3",
  "title": "Course 3 — Collaboration",
  "version": "optional",
  "steps": [
    {
      "id": "malikas-window-in-this-base",
      "type": "course",
      "title": "Step 3a · Malika’s window in this base",
      "instruction": "One short sentence for the floating toolbar.",
      "html": "<h1>…</h1><p>…</p>",
      "continuesOn": "plugin",
    },
  ],
}
```

A manifest must have a non-empty `steps` array. Each step:

- **`id`** — the step's title without its `Step N ·` prefix, in lower case, accents and
  apostrophes removed, words joined by hyphens: `Step 3a · Malika’s window in this base` →
  `malikas-window-in-this-base`; the introduction is `introduction`. Unique within the course
  (the same id in two courses is fine). `npm run check-texts` enforces it. Saved progress
  and checkmarks are keyed on it, so from the first public release on it is **frozen**,
  even if the title is reworded (a new id resets that step for every learner) — and the
  id check goes from `check-texts`, which would otherwise demand the new slug.
- **`type`** — `course` (full-height page) or `exercise` (compact banner over the base).
- **`title`** — shown in the step list, e.g. `Step 3a · …`. The manifest is deliberately
  **gapped**: it holds only the plugin's checkpoints, while the website carries the course.
- **`html`** or **`contentUrl`** — the body, as an HTML fragment (no `<html>`/`<head>`).
  Inline `html` wins. Rendered with `dangerouslySetInnerHTML`: trusted content only.
  SeaTable icons work (`<i class="dtable-font dtable-icon-…"></i>`).
- **`instruction`** — one short sentence for the floating toolbar (else the stripped body).
- **`continuesOn`** — where the course goes after this step: `website` (a "continues on
  the website" line) or `plugin` (a Next button to the following manifest step).
- **`hint`** — optional, behind the Hint button; HTML like the body (icons work).
- **`successMessage`**, **`handoffNote`** — optional texts.

### Exercises: `grade`

An exercise is checked against the live base with one of these rules (`grader.ts`):

| `kind`            | Checks                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `cells` (default) | given rows hold given values: `{ table_name, expected: [{ row_id, row: { Column: value } }], match }` |
| `rows-exist`      | at least `min_count` rows where a column equals a value                                               |
| `automation-set`  | an automation sets a column (optionally under a condition)                                            |
| `automation-rule` | an automation's trigger, conditions and actions                                                       |
| `plugin-ui`       | a plugin UI state (the Welcome tour's toolbar check)                                                  |

Values are **display values** (a single-select label, not its option id), as in the
API-Gateway Update-Row payload.

### Actions and windows: `demo`

Some steps do something in the base instead of checking it. `demo` names the action and a
matching field carries its payload — for Course 3: `colleague-setup` (Malika's token),
`colleague-window` + `colleagueWindow` (her home page or her window in the base),
`colleague-write` + `colleagueWrite` / `colleagueReply` / `colleagueSideWrites` (her edits
and reply). Also `demoLabel`, `demoDoneMessage`, `watchTable`, `watchView`. The Course 4
actions (`seed`, `rewind`, `watch`, `burst`, `automationStages`, …) are documented on
`CourseStep`.

These payloads are part of the content, but the code that runs them is not: a manifest can
only use an action this version of the plugin knows.

**Rule — say it before doing it.** The plugin never changes a base on its own: every action
runs only when the learner presses its button, and the step's text says beforehand what it
will create, change or remove — including what a second run removes first (a step with
`reset` clears what its previous run left, before seeding again). The help page promises
this ("it tells you each time what it is about to do"); a new action step keeps that promise
in its `html`, and its `demoLabel` names what the button does in the base.

## Serving it

- **CORS**: the plugin runs on the SeaTable origin and fetches cross-origin, so the host
  must send `Access-Control-Allow-Origin` for the SeaTable server(s) using the plugin.
- Any static file server works (nginx, `npx http-server <dir> --cors`, …). No server-side
  logic is needed.
- The plugin needs to reach the host: a server without internet access will not load
  remote content.
