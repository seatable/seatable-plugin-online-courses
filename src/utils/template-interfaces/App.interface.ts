export interface IAppProps {
  isDevelopment?: boolean;
  lang?: string;
}
export interface AppIsShowState {
  isShowPlugin: boolean;
  isLoading: boolean;
  isShowPresets: boolean;
}

/**
 * What the plugin keeps in the base (its plugin settings), written by courseStore.ts
 * only. Keys left by earlier builds (`presets`, `pluginName`, `activePresetIdx`…) are
 * ignored and dropped at the next write.
 */
export interface IPluginDataStore {
  // The course open in the left-hand list, so the plugin reopens on it.
  activeCourseId?: string;
  // Where builds before 2026-11-12 kept the same thing — read, never written.
  activePresetId?: string;
  // Course progress: the id of the last-reached step, keyed by courseId. One
  // plugin serves all the courses, so it's a per-course map.
  courseProgress?: { [courseId: string]: string };
  // Per-course marks: a step's action has run, a step's verify has passed, the
  // Course 4 delivery has been taken out. See courseStore.ts.
  courseFlags?: { [courseId: string]: { [key: string]: boolean } };
  // Course 3 stages a colleague and acts for her with her own account token,
  // kept here so it survives a cleared cache, another browser or another machine.
  // See colleagueIdentity.ts for the trade that decision makes.
  colleagueAccountToken?: string;
  // Last position (top-left, px) of the floating toolbar, so it re-pops where the
  // learner left it next time. Defaults to the bottom-left.
  floatIconPos?: { x: number; y: number };
  // Height (px) the learner gave the exercise banner with the resize handle. Used for
  // every banner page instead of the fit-to-content height. Unset until they resize.
  bannerHeight?: number;
}

export interface AvailableLocales {
  [key: string]: any;
}
