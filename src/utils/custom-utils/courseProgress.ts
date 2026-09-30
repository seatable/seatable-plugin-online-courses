/**
 * Course progress in the plugin datastore. One plugin serves all seven courses,
 * so progress is a per-course map { [courseId]: stepId } — the id of the last
 * step the learner reached, so they resume exactly where they left off.
 *
 * Content does NOT live here (that's Hugo, see courseContent.ts). The datastore
 * only stores the resume pointer. Persisted via updatePluginSettings, the same
 * same updatePluginSettings pattern used elsewhere in the plugin datastore.
 */

import { PLUGIN_NAME } from '../template-constants';
import { IPluginDataStore } from '../template-interfaces/App.interface';

function sdk(): any {
  return (window as any).dtableSDK;
}

function readStore(): IPluginDataStore {
  return (sdk()?.getPluginSettings?.(PLUGIN_NAME) as IPluginDataStore) || ({} as IPluginDataStore);
}

type FlagMap = { [courseId: string]: { [key: string]: boolean } };
type ProgressMap = { [courseId: string]: string };

/**
 * ⚠️ What WE have written, kept in memory — because the datastore is written from
 * more than one place and not every writer knows about these keys.
 *
 * `app.tsx` rewrites the whole store from a React state captured earlier
 * (`updatePluginDataStore`), which has no `courseFlags` in it; and a read-modify-write
 * here can read a store that does not yet reflect the write before it. Either way the
 * mark we just stored is dropped — which is exactly how Step 5a's "done" vanished the
 * moment the learner paged away and came back (2026-08-27).
 *
 * So: merge these over every read, and write the whole merged picture back on every
 * write, so the persisted store repairs itself at the next one.
 */
const written: { flags: FlagMap; progress: ProgressMap } = { flags: {}, progress: {} };

function mergedFlags(store: IPluginDataStore): FlagMap {
  const out: FlagMap = { ...(store.courseFlags || {}) };
  Object.keys(written.flags).forEach((courseId) => {
    out[courseId] = { ...(out[courseId] || {}), ...written.flags[courseId] };
  });
  return out;
}

function mergedProgress(store: IPluginDataStore): ProgressMap {
  return { ...(store.courseProgress || {}), ...written.progress };
}

/** Persist both maps together — never one without the other, or we drop the other. */
function persist(store: IPluginDataStore): void {
  sdk()?.updatePluginSettings?.(PLUGIN_NAME, {
    ...store,
    courseFlags: mergedFlags(store),
    courseProgress: mergedProgress(store),
  });
}

/** The last-reached step id for a course, or null if the learner is new to it. */
export function getCurrentStepId(courseId: string): string | null {
  return mergedProgress(readStore())[courseId] ?? null;
}

/**
 * Has this learner already run a one-way action of this course? Kept in the
 * datastore rather than in React state because the flow leaves the plugin in
 * between: Step 4's rewind empties the base, the learner goes off to the app to
 * receive the delivery again, and comes back — by which time session state has
 * long forgotten, and offering "rewind" again would delete what they just got.
 */
export function getCourseFlag(courseId: string, key: string): boolean {
  return mergedFlags(readStore())[courseId]?.[key] ?? false;
}

export function setCourseFlag(courseId: string, key: string, value: boolean): void {
  written.flags[courseId] = { ...(written.flags[courseId] || {}), [key]: value };
  persist(readStore());
}

/** Remember the learner's current step for a course (for resume next time). */
export function setCurrentStepId(courseId: string, stepId: string): void {
  written.progress[courseId] = stepId;
  persist(readStore());
}
