# Course content example

Reference layout for the **course content the plugin fetches at runtime** (see
`src/utils/custom-utils/courseContent.ts`). In production this is built and served
by the Hugo course site; this folder is a hand-written sample for authors and for
local testing.

## Layout

```
course-content-example/        ← serve this dir as CONTENT_BASE
└── course-3/                   ← one folder per courseId
    ├── manifest.json           ← ordered steps + answer keys
    ├── le01.html               ← step content fragments (HTML body only)
    ├── ex01.html
    ├── le02.html
    └── ex02.html
```

The plugin fetches `${CONTENT_BASE}/${courseId}/manifest.json`, then each step's
`contentUrl` relative to the course folder.

## manifest.json

```jsonc
{
  "courseId": "course-3",
  "title": "Collaboration",
  "steps": [
    { "id": "le01", "type": "course",   "title": "...", "contentUrl": "le01.html" },
    { "id": "ex01", "type": "exercise", "title": "...", "contentUrl": "ex01.html",
      "hint": "shown behind the Help toggle",
      "grade": { ...answer key... } }
  ]
}
```

- **`id`** — 4 alphanumeric chars (same format as SeaTable's `tid`/`vid`). This is the
  `qid` deep-link value: opening the plugin with `?qid=ex01` jumps straight to that step.
- **`type`** — `course` (full-height lesson page) or `exercise` (compact bottom banner).
- **`contentUrl`** — an HTML **fragment** (body markup, no `<html>`/`<head>`). Rendered
  via `dangerouslySetInnerHTML`, so it's trusted content — author it, don't accept it
  from learners.
- **`hint`** — optional; surfaced behind the exercise "Help" button.
- **`grade`** — only on exercises (omit on lessons).

## Grade rules = the Update-Row payload, used as an answer key

A grade rule reuses the API-Gateway **Update-Row** shape. The same
`{ row_id, row: { Column: value } }` objects you'd use to _write_ a row also _assert_ it:

```jsonc
"grade": {
  "table_name": "Customers",
  "match": "all",                       // "all" (default) | "any"
  "expected": [
    { "row_id": "<base _id>", "row": { "Status": "Client" } }
  ]
}
```

- **`row_id`** is the base `_id`. Each course ships as a **fixed imported base**, so the
  ids are identical for every learner — you can hardcode them here. Grab an id from the
  row's expand panel, the API, or `dtableSDK.getTables()[…].rows[i]._id`.
- **`row`** keys are column **names**, values are **display values** (single-select
  labels, not option ids — same as the Update-Row endpoint).
- **`match`**: `all` = every expected row must match; `any` = at least one.

> The example manifest ships with `REPLACE_WITH_…_ROW_ID` placeholders — swap in the real
> `_id`s from your course-3 base before grading will pass.

## Local testing (before the Hugo host exists)

1. Fill in the real `row_id`s in `course-3/manifest.json`.
2. Serve this folder with CORS enabled, e.g.:
   ```bash
   npx http-server course-content-example -p 8085 --cors
   ```
3. Point the plugin at it — set `CONTENT_BASE` in `courseContent.ts` to
   `http://localhost:8085` (so it fetches `http://localhost:8085/course-3/manifest.json`).

If the manifest can't be fetched, the plugin falls back to a bundled single-exercise demo
(`buildFallbackManifest` in `OnlineCourse/index.tsx`), so the UI still renders.

## Production notes

- Host needs `Access-Control-Allow-Origin` for the SeaTable origin(s) — the plugin fetches
  cross-origin. This is a static-asset fetch, **not** an external service, so it keeps the
  "1-click, no Docker" rule. It does require internet; fully-offline self-hosted installs
  are out of scope.
- Add a new course by creating a sibling folder (`course-4/`, …) with its own `manifest.json`.
