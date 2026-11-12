'use strict';

/**
 * Check that every course text file has the shape of its English reference:
 *
 *   node scripts/check-course-texts.js        (or: npm run check-texts)
 *
 * For each src/content/<courseId>/manifest.<lang>.json other than English, it reports:
 *   - errors   — a key English does not have (a renamed or deleted step, a typo: the
 *                text would never be shown), and a `{placeholder}` that differs from
 *                the English one (a value from the logic that would go missing);
 *   - missing  — a text English has and this language does not. Not an error: the
 *                plugin shows the English one instead, so a partial translation works.
 *
 * Exits with 1 when there is at least one error.
 */

const fs = require('fs');
const path = require('path');

const contentDir = path.resolve(__dirname, '..', 'src', 'content');
const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join(' ');

// Flatten { steps: { a: { title } } } into { 'steps.a.title': '…' }.
function flatten(obj, prefix = '', out = {}) {
  Object.keys(obj).forEach((key) => {
    const value = obj[key];
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, name, out);
    else out[name] = value;
  });
  return out;
}

// The H1 rule (2026-11-10): a full-height page ('course') opens on its H1; an
// exercise — the compact banner over the base — has none, to keep the room for the
// base. Each step's type is in the logic, so it is read from courseContent.ts: every
// `id: '…'` and the first `type: '…'` after it, before the next id.
const logicFile = path.resolve(__dirname, '..', 'src', 'utils', 'custom-utils', 'courseContent.ts');
const stepTypes = {};
{
  const source = fs.readFileSync(logicFile, 'utf8');
  const re = /\bid: '([\w-]+)'([\s\S]*?)(?=\bid: '|$)/g;
  let m;
  while ((m = re.exec(source))) {
    const type = /\btype: '(course|exercise)'/.exec(m[2]);
    if (type) stepTypes[m[1]] = type[1];
  }
}
function h1Errors(json) {
  const out = [];
  Object.entries(json.steps || {}).forEach(([id, step]) => {
    const html = typeof step.html === 'string' ? step.html : null;
    const type = stepTypes[id];
    if (html == null || !type) return;
    if (type === 'course' && !/^\s*<h1>/.test(html))
      out.push(`steps.${id}.html: a full-height page must open on its <h1>`);
    if (type === 'exercise' && /<h1>/.test(html))
      out.push(`steps.${id}.html: an exercise has no <h1>`);
    // Text before the first tag, then a closing </p>: the opening <p> is missing.
    if (/^\s*[^<\s]/.test(html) && /<\/p>/.test(html))
      out.push(`steps.${id}.html: starts outside a <p> but closes one`);
    // Every <p> closed: an unclosed last paragraph renders fine and so went unseen,
    // in six Course 4 steps in every language (found 2026-11-12).
    const opened = (html.match(/<p[\s>]/g) || []).length;
    const closed = (html.match(/<\/p>/g) || []).length;
    if (opened !== closed) out.push(`steps.${id}.html: ${opened} <p> opened, ${closed} closed`);
  });
  return out;
}

/**
 * A step's id is its English title, without the `Step N · ` prefix, in lower case,
 * accents and apostrophes removed, words joined by hyphens (course-content-example/
 * README.md). Enforced while the plugin has no learners, so a retitled step gets the
 * id that matches; once it is public, ids are frozen and this check goes.
 */
function slug(title) {
  return title
    .replace(/^Step \S+\s*·\s*/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
function stepIdErrors(json) {
  return Object.entries(json.steps || {})
    .filter(([id, step]) => typeof step.title === 'string' && slug(step.title) !== id)
    .map(([id, step]) => `steps.${id}: the id of "${step.title}" is "${slug(step.title)}"`);
}

let errors = 0;
for (const courseId of fs.readdirSync(contentDir).sort()) {
  const dir = path.join(contentDir, courseId);
  if (!fs.statSync(dir).isDirectory()) continue;
  const englishFile = path.join(dir, 'manifest.en.json');
  if (!fs.existsSync(englishFile)) {
    console.log(`✗ ${courseId}: manifest.en.json is missing`);
    errors += 1;
    continue;
  }
  const englishJson = JSON.parse(fs.readFileSync(englishFile, 'utf8'));
  const english = flatten(englishJson);
  [...h1Errors(englishJson), ...stepIdErrors(englishJson)].forEach((e) => {
    console.log(`✗ ${courseId}/manifest.en.json\n    error   ${e}`);
    errors += 1;
  });
  const others = fs
    .readdirSync(dir)
    .filter((f) => /^manifest\.[\w-]+\.json$/.test(f) && f !== 'manifest.en.json')
    .sort();
  for (const file of others) {
    const localJson = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const local = flatten(localJson);
    h1Errors(localJson).forEach((e) => {
      console.log(`✗ ${courseId}/${file}\n    error   ${e}`);
      errors += 1;
    });
    const unknown = Object.keys(local).filter((k) => !(k in english));
    const wrongPlaceholders = Object.keys(local).filter(
      (k) => k in english && placeholders(String(local[k])) !== placeholders(String(english[k]))
    );
    const missing = Object.keys(english).filter((k) => !(k in local));
    const label = `${courseId}/${file}`;
    if (!unknown.length && !wrongPlaceholders.length && !missing.length) {
      console.log(`✓ ${label}`);
      continue;
    }
    console.log(`${unknown.length || wrongPlaceholders.length ? '✗' : '·'} ${label}`);
    unknown.forEach((k) => console.log(`    error   ${k}: not in English`));
    wrongPlaceholders.forEach((k) =>
      console.log(
        `    error   ${k}: placeholders "${placeholders(String(local[k]))}", English has "${placeholders(String(english[k]))}"`
      )
    );
    if (missing.length) console.log(`    missing ${missing.length} text(s), shown in English`);
    errors += unknown.length + wrongPlaceholders.length;
  }
}

if (errors) {
  console.log(`\n${errors} error(s)`);
  process.exit(1);
}
