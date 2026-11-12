# SeaTable Plugin Online courses

**Online courses** is a SeaTable plugin that works as a **learning companion** for the
[SeaTable online courses](https://seatable.com/help/online-courses/). It does not give you a
new view of your data: it walks you through the hands-on exercises of a course and **checks
your work directly in your own base**.

![The Online courses plugin open on a base, with the list of steps on the left and the current exercise and its Verify button on the right](docs/online-courses-plugin.png)

## How it works with the courses

A course is followed mainly on the **website**, where the whole story unfolds step by step.
At certain points it asks you to **open the plugin and pick a step**: that is where you
actually do something in your base.

- The **website** carries the narrative: it explains each concept and shows what to build
  and why.
- The **plugin** works with you inside your base. It reads your data and confirms that the
  automation you built triggers correctly, that your script produced the right values, or
  that your view is set up as expected — and gives you immediate feedback.

It does more than mark the result:

- **Guided builds** — when an operation has several stages (the trigger of an automation,
  then its conditions, then each action), it can take you through them one at a time,
  checking each stage before the next.
- **Changes in your base** — it can bring in the records a step works on, or undo what a
  previous step produced so you can run it again. It tells you each time what it is about
  to do.
- **A stand-in colleague** (Course 3 – Collaboration) — with the account token of a second
  account in your team, it shows you what your colleague sees (her home page, her
  notifications) and acts for her: edits signed with her name, replies in a comment thread.
  You never have to sign in as her.

Exercise pages shrink the plugin to a banner at the bottom of the window so the base stays
in view; the plugin can also be collapsed into a small toolbar you drag anywhere.

## Courses

| Course                              | In the plugin                                                            |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Welcome — using the plugin          | A short tour of the companion, fully in the plugin. Start here.          |
| Course 3 – Collaboration            | Supported: sharing, comments, activity log (with the stand-in colleague) |
| Course 4 – Automation & Integration | Supported                                                                |
| Courses 1 and 2                     | Listed with a link to follow the course on the website                   |
| Courses 5–7                         | Listed as coming soon                                                    |

Course content is bundled in the plugin (team decision, 2026-10-06). The code that could
serve it from an external host is kept, switched off, in case that changes; the contract
such a host would follow is described in
[`course-content-example/README.md`](course-content-example/README.md).

## How to install

A plugin is installed by the system administrator of the SeaTable server, then activated
in any base by its users. See the
[SeaTable Admin Manual](https://admin.seatable.io/configuration/plugins/?h=plugins) for the
installation, and the
[help article](https://seatable.com/help/activate-plugin-in-base/) for
activating a plugin in a base.

Build the installable package with:

```bash
npm install
npm run build-plugin
```

This formats the code, builds it and writes `plugin-zip/online-courses-<version>.zip`. The
version comes from `src/plugin-config/info.json`.

## Development

1. Copy `src/setting.local.dist.js` to `src/setting.local.js` (ignored by git) and fill in
   your server, base name, workspace id and a base API token.
   - `accountToken` (or `username` / `password`) is needed for the checks that read
     account-level data, such as a base's automation rules.
   - `colleagueAccountToken` is the second account's token for Course 3. In a real base the
     plugin's setup step stores it in the plugin datastore instead.
2. Run `npm start` and open the dev server.

Useful places in the code:

- `src/utils/custom-utils/courseContent.ts` — the course list and the steps of each course.
- `src/utils/custom-utils/grader.ts`, `opLogGrade.ts` — the checks.
- `src/utils/custom-utils/courseStore.ts` — progress and settings kept in the base.
- `src/components/custom-components/OnlineCourse/` — the step runner and the colleague's
  window.

## Origin

The plugin started as a copy of SeaTable's
[Table relationships plugin](https://github.com/seatable/seatable-plugin-table-relationship)
(v1.2.3), itself built on the
[SeaTable plugin template](https://github.com/seatable/seatable-plugin-template-base). The
build setup (`config/`, `scripts/`) comes from there; the history of that plugin is not
carried over.
