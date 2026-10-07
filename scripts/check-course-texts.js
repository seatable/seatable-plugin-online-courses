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
  const english = flatten(JSON.parse(fs.readFileSync(englishFile, 'utf8')));
  const others = fs
    .readdirSync(dir)
    .filter((f) => /^manifest\.[\w-]+\.json$/.test(f) && f !== 'manifest.en.json')
    .sort();
  for (const file of others) {
    const local = flatten(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
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
