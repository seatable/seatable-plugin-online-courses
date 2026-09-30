# Course content served to the plugin

The contract between the plugin and a content host: what the host serves, and what the
plugin expects to find there. Types and field-by-field documentation are in
`src/utils/custom-utils/courseContent.ts` (`CourseStep`, `CourseManifest`) and
`src/utils/custom-utils/grader.ts` (grade rules) — this file is the overview.

> **Status — not wired yet.** Every course is still bundled in the plugin:
> `loadAllCourses()` returns `buildAllFallbackManifests()`, and `fetchManifest()` /
> `fetchStepHtml()` exist but nothing calls the remote path (the `USE_REMOTE_CONTENT`
> flag is declared, not read). Wiring it is the point of the academy POC.

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
      "id": "cv03",
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

- **`id`** — a short id, unique in the course (`cs00`, `cv03`…). Saved progress and checkmarks are keyed
  on it: changing an id resets that step for every learner.
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

## Serving it

- **CORS**: the plugin runs on the SeaTable origin and fetches cross-origin, so the host
  must send `Access-Control-Allow-Origin` for the SeaTable server(s) using the plugin.
- Any static file server works (nginx, `npx http-server <dir> --cors`, …). No server-side
  logic is needed.
- The plugin needs to reach the host: a server without internet access will not load
  remote content.
