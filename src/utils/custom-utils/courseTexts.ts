/**
 * The words of each course, one file per language:
 *
 *   src/content/<courseId>/manifest.<lang>.json     (manifest.en.json, manifest.fr.json, …)
 *
 * Every file has the same shape — `CourseTexts` below — and holds nothing but text:
 * the steps, their order, their grade rules and what the plugin writes into a base are
 * logic, and stay in courseContent.ts, once for every language. A translator can
 * therefore not break a check, and a course reads the same way in every file.
 *
 * Steps are keyed by their id, so the order is never repeated here. English is the
 * reference: a text missing from another language falls back to it, field by field,
 * so a step that has not been translated yet shows in English rather than empty.
 *
 * `{name}` in a text is filled from the params courseContent.ts passes for that course
 * — a value that also lives in the logic (a delivery reference the grade checks) is
 * written once, there, and never copied into the translations.
 */

export interface StepTexts {
  title?: string;
  instruction?: string;
  hint?: string;
  html?: string;
  successMessage?: string;
  handoffNote?: string;
  demoLabel?: string;
  demoDoneMessage?: string;
  grade?: { noun?: string };
  colleagueWindow?: { caption?: string };
  watch?: { html?: string; instruction?: string; successMessage?: string };
  /** Keyed by the stage id (`created`, `trigger`, `action:0`…). */
  automationStages?: Record<
    string,
    { title?: string; instruction?: string; hint?: string; html?: string }
  >;
}

export interface CourseTexts {
  /** The course's name, in the course list. */
  title: string;
  /** Its description, on the course's introduction page. HTML. */
  intro: string;
  steps: Record<string, StepTexts>;
}

export const FALLBACK_LANG = 'en';

const files = require.context('../../content', true, /manifest\.[\w-]+\.json$/);

// courseId → lang → texts
const TEXTS: Record<string, Record<string, CourseTexts>> = {};
files.keys().forEach((key) => {
  const match = key.match(/^\.\/([^/]+)\/manifest\.([\w-]+)\.json$/);
  if (!match) return;
  const [, courseId, lang] = match;
  TEXTS[courseId] = TEXTS[courseId] || {};
  TEXTS[courseId][lang] = files(key);
});

/** The language SeaTable is displayed in — the same one the plugin's interface uses. */
export function contentLang(): string {
  const lang = (window as any).dtable?.lang;
  return typeof lang === 'string' && lang ? lang : FALLBACK_LANG;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// `over` wins wherever it says something; anything it leaves out comes from `base`.
function mergeTexts<T>(base: T, over: any): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return (over ?? base) as T;
  const out: Record<string, any> = { ...base };
  Object.keys(over).forEach((key) => {
    out[key] = key in out ? mergeTexts(out[key], over[key]) : over[key];
  });
  return out as T;
}

/** A course's texts in `lang`, completed from English where that language is silent. */
export function getCourseTexts(courseId: string, lang: string = contentLang()): CourseTexts {
  const english = TEXTS[courseId]?.[FALLBACK_LANG];
  if (!english) throw new Error(`No texts for course "${courseId}" (manifest.en.json missing)`);
  const local = lang === FALLBACK_LANG ? undefined : TEXTS[courseId]?.[lang];
  return local ? mergeTexts(english, local) : english;
}

/** Replace each `{name}` with `params[name]`; an unknown name is left as it is. */
export function fillParams(text: string, params: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? params[name] : whole));
}
