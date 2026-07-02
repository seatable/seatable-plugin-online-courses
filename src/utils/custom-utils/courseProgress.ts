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

/** The last-reached step id for a course, or null if the learner is new to it. */
export function getCurrentStepId(courseId: string): string | null {
  return readStore().courseProgress?.[courseId] ?? null;
}

/** Remember the learner's current step for a course (for resume next time). */
export function setCurrentStepId(courseId: string, stepId: string): void {
  const store = readStore();
  sdk()?.updatePluginSettings?.(PLUGIN_NAME, {
    ...store,
    courseProgress: { ...(store.courseProgress || {}), [courseId]: stepId },
  });
}
