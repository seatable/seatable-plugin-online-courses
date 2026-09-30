/* eslint-disable react-hooks/exhaustive-deps */
import React, { useCallback, useEffect, useRef, useState } from 'react';

// Import of Component
import Header from './components/template-components/Header';
import PluginSettings from './components/template-components/PluginSettings';
import PluginPresets from './components/template-components/PluginPresets';
import ResizableWrapper from './components/template-components/ResizableWrapper';
import CustomPlugin from './components/custom-components/index';
// Import of Interfaces
import {
  AppActiveState,
  AppIsShowState,
  IAppProps,
  IPluginDataStore,
} from './utils/template-interfaces/App.interface';
import { AuditTableDisplayState } from './utils/custom-interfaces/AuditTypes';
import {
  TableArray,
  TableViewArray,
  Table,
  TableView,
  TableRow,
  IActiveTableAndView,
} from './utils/template-interfaces/Table.interface';
import { PresetsArray } from './utils/template-interfaces/PluginPresets/Presets.interface';
// Import of CSS
import styles from './styles/template-styles/Plugin.module.scss';
import './assets/css/plugin-layout.css';
// The plugin's own icon — used for the floating "movable icon" puck.
import pluginIcon from './plugin-config/icon.png';
import { FloatControls } from './utils/custom-interfaces/FloatControls';
// Import of Constants
import {
  INITIAL_IS_SHOW_STATE,
  INITIAL_CURRENT_STATE,
  PLUGIN_NAME,
  DEFAULT_PLUGIN_DATA,
  ACTIVE_PRESET_ID,
} from './utils/template-constants';
import './locale';
import {
  cleanActiveTable,
  cleanActiveTableViews,
  cleanAllTables,
  createDefaultPluginDataStore,
  findPresetName,
  getActiveStateSafeGuard,
  getActiveTableAndActiveView,
  getPluginDataStore,
  isMobile,
  parsePluginDataToActiveState,
} from './utils/template-utils/utils';
import {
  CourseManifest,
  loadAllCourses,
  resolveInitialStepId,
} from './utils/custom-utils/courseContent';
import { setCurrentStepId } from './utils/custom-utils/courseStore';

// Plugin-window height presets (fraction of viewport, with a px floor): the full
// lesson view vs the compact exercise banner at the bottom of the window.
const HEIGHT_EXPANDED = { ratio: 0.95, minPx: 320 };
const HEIGHT_REDUCED = { ratio: 0.22, minPx: 130 };

// Resize the plugin window, mirroring ResizableWrapper: set the modal height and
// anchor the host to the bottom of the viewport.
function setPluginHeight({ ratio, minPx }: { ratio: number; minPx: number }) {
  const host = document.querySelector('#plugin-wrapper') as HTMLElement | null;
  if (!host) return;
  const modal = host.firstElementChild as HTMLElement | null;
  const px = Math.max(Math.round(window.innerHeight * ratio), minPx);
  if (modal) {
    modal.style.transition = 'height 0.2s ease';
    modal.style.height = `${px}px`;
  }
  host.style.top = `calc(100% - ${px}px)`;
}

// Floating ("shrunk to a movable toolbar") mode. The normal reduced view is a
// full-width bar pinned to the bottom, so it always covers the bottom-of-panel
// action buttons (e.g. an automation's Add/Save). Instead we shrink the modal to a
// small draggable TOOLBAR at (x, y) and make the REST of the plugin host click-
// through (pointer-events: none), re-enabling events only on the toolbar — so the
// learner can interact with the entire base behind it while still reading the
// instruction and verifying the step (no re-expanding).
const FLOAT_W = 224;
const FLOAT_H = 44;

function floatingEls(): { host: HTMLElement; modal: HTMLElement } | null {
  const host = document.querySelector('#plugin-wrapper') as HTMLElement | null;
  const modal = host?.firstElementChild as HTMLElement | null;
  return host && modal ? { host, modal } : null;
}

function setPluginFloating(x: number, y: number) {
  const els = floatingEls();
  if (!els) return;
  const { host, modal } = els;
  // Clamp inside the viewport so the toolbar can't be dragged off-screen.
  const cx = Math.max(0, Math.min(x, window.innerWidth - FLOAT_W));
  const cy = Math.max(0, Math.min(y, window.innerHeight - FLOAT_H));
  host.style.pointerEvents = 'none'; // whole host is click-through…
  modal.style.pointerEvents = 'auto'; // …except the toolbar itself
  modal.style.transition = 'none';
  modal.style.top = `${cy}px`;
  modal.style.left = `${cx}px`;
  modal.style.right = 'auto';
  modal.style.bottom = 'auto';
  modal.style.width = `${FLOAT_W}px`;
  modal.style.height = `${FLOAT_H}px`;
  // Transparent + overflow-visible so the toolbar and its info popover show without
  // a modal box behind them.
  modal.style.background = 'transparent';
  modal.style.overflow = 'visible';
}

function clearPluginFloating() {
  const els = floatingEls();
  if (!els) return;
  const { host, modal } = els;
  host.style.pointerEvents = '';
  // Drop every inline override so the modal returns to its stylesheet defaults
  // (full-width bar); the caller then re-applies the normal height.
  for (const prop of [
    'pointerEvents',
    'top',
    'left',
    'right',
    'bottom',
    'width',
    'background',
    'overflow',
  ]) {
    modal.style.removeProperty(prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`));
  }
}

const App: React.FC<IAppProps> = (props) => {
  const { isDevelopment, lang } = props;

  // Boolean state to show/hide the plugin's components
  const [isShowState, setIsShowState] = useState<AppIsShowState>(INITIAL_IS_SHOW_STATE);
  const { isShowPlugin, isShowSettings, isLoading, isShowPresets } = isShowState;
  // Tables, Presets, Views as dataStates. The main data of the plugin
  const [allTables, setAllTables] = useState<TableArray>([]);
  const [activeTableViews, setActiveTableViews] = useState<TableViewArray>([]);
  const [pluginDataStore, setPluginDataStore] = useState<IPluginDataStore>(DEFAULT_PLUGIN_DATA);
  const [pluginPresets, setPluginPresets] = useState<PresetsArray>([]);
  // Transient: true while the on-demand performance analysis is in flight.
  // Used by PluginSettings to disable the staleness-rerun link.
  const [perfRunning, setPerfRunning] = useState(false);
  // appActiveState: Define the app's active Preset + (Table + View) state using the useState hook
  const [appActiveState, setAppActiveState] = useState<AppActiveState>(INITIAL_CURRENT_STATE);
  // Destructure properties from the app's active state for easier access
  const { activeTable, activePresetId, activePresetIdx } = appActiveState;

  // Course navigation state — source of truth for BOTH the left-panel tree and
  // the (controlled) OnlineCourse runner. The active course is the selected preset
  // (preset _id === courseId); we hold every course's manifest + the current step
  // per course. The `qid`/`cid` URL params are dead in prod (dtable-web strips
  // unknown params), so navigation is entirely in-plugin.
  const [courses, setCourses] = useState<CourseManifest[]>([]);
  const [stepByCourse, setStepByCourse] = useState<Record<string, string>>({});
  const manifestLoaded = useRef(false);

  // Active course follows the selected preset; guard against a stale/unknown id
  // (e.g. localStorage left over from the old single-preset build).
  const activeCourseId = courses.some((c) => c.courseId === activePresetId)
    ? activePresetId
    : (courses[0]?.courseId ?? '');
  const activeManifest = courses.find((c) => c.courseId === activeCourseId) ?? null;
  const activeStepId = activeCourseId ? (stepByCourse[activeCourseId] ?? null) : null;
  const activeStep = activeManifest?.steps.find((s) => s.id === activeStepId) ?? null;

  // Plugin window sizing. Each page has a natural size (lesson → full height,
  // exercise → compact banner). To get out of the way, the learner shrinks to the
  // floating toolbar (below) — no separate "minimize to header bar" mode, since the
  // toolbar frees the whole base, which minimizing never did.
  const naturalExpanded = activeStep?.type !== 'exercise';
  const compact = !naturalExpanded;

  // Floating mode: the plugin is shrunk to a small draggable toolbar so the learner
  // can reach the whole base behind it (the reduced bar covers panel action
  // buttons). floatPos is the toolbar's top-left, kept across drags.
  const [floating, setFloating] = useState(false);
  // Default: bottom-LEFT, a little clear of the viewport edges.
  const [floatPos, setFloatPos] = useState<{ x: number; y: number }>(() => ({
    x: 20,
    y: window.innerHeight - FLOAT_H - 24,
  }));
  const floatPosLoaded = useRef(false);
  // The current step's instruction + actions, reported up by the runner — the
  // floating toolbar renders (and drives the step) from this. Stable setter so the
  // runner's report effect doesn't churn.
  const [floatControls, setFloatControls] = useState<FloatControls | null>(null);
  const reportFloatControls = useCallback((fc: FloatControls) => setFloatControls(fc), []);
  // Natural height of the exercise banner's content (px), reported by the runner, so
  // the plugin grows to show the whole instruction/hint/result without scrolling.
  const [exerciseContentPx, setExerciseContentPx] = useState(0);
  const reportContentHeight = useCallback((px: number) => setExerciseContentPx(px), []);
  const currentSize = () => {
    if (naturalExpanded) return HEIGHT_EXPANDED;
    // Chrome around the banner content: header + body/banner padding + a small
    // buffer. Grow to fit, but never below the reduced floor nor above 75% of the
    // viewport (beyond that the banner scrolls rather than swallow the screen).
    const CHROME = 102;
    const max = Math.round(window.innerHeight * 0.75);
    const px = Math.min(Math.max(exerciseContentPx + CHROME, HEIGHT_REDUCED.minPx), max);
    return { ratio: 0, minPx: px };
  };

  useEffect(() => {
    initPluginDTableData();
    return () => {
      unsubscribeLocalDtableChanged();
      unsubscribeRemoteDtableChanged();
    };
  }, []);

  useEffect(() => {
    if (isMobile()) {
      setIsShowState((prevState) => ({ ...prevState, isShowPresets: false }));
    }
  }, []);

  // Load all demo courses once base data is ready (the offline fallback reads the
  // SDK tables), then set each course's initial step (resume > first). Loads once.
  useEffect(() => {
    if (isLoading || manifestLoaded.current) return;
    manifestLoaded.current = true;
    let cancelled = false;
    (async () => {
      const all = await loadAllCourses();
      if (cancelled) return;
      const initial: Record<string, string> = {};
      all.forEach((m) => {
        initial[m.courseId] = resolveInitialStepId(m, m.courseId);
      });
      setCourses(all);
      setStepByCourse(initial);
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoading]);

  // Navigate to a step, from the runner (active course) or the tree (any course):
  // activate that course and remember the step so the learner resumes there.
  const onSelectStep = (courseId: string, stepId: string) => {
    if (courseId !== activePresetId) onSelectPreset(courseId);
    setStepByCourse((prev) => ({ ...prev, [courseId]: stepId }));
    setCurrentStepId(courseId, stepId);
  };

  // Apply the plugin-window height whenever the effective size changes — but never
  // while floating (the toolbar owns the modal geometry then).
  useEffect(() => {
    if (!activeStep || floating) return;
    setPluginHeight(currentSize());
  }, [naturalExpanded, activeStepId, activeStep, floating, exerciseContentPx]);

  // Enter/exit floating: apply the puck geometry, or tear it down and restore the
  // normal window size.
  useEffect(() => {
    if (floating) setPluginFloating(floatPos.x, floatPos.y);
    else {
      clearPluginFloating();
      if (activeStep) setPluginHeight(currentSize());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floating]);

  // Restore the saved puck position from the datastore once it has loaded (else
  // keep the bottom-left default).
  useEffect(() => {
    if (floatPosLoaded.current || isLoading) return;
    if (pluginDataStore?.floatIconPos) setFloatPos(pluginDataStore.floatIconPos);
    floatPosLoaded.current = true;
  }, [isLoading, pluginDataStore]);

  // Shrink to / restore from the floating toolbar.
  const onFloat = () => setFloating(true);
  const onRestoreFromFloat = () => setFloating(false);
  // Persist the puck's new position so it re-pops there next time.
  const saveFloatPos = (pos: { x: number; y: number }) => {
    setFloatPos(pos);
    floatPosLoaded.current = true;
    const updated = { ...pluginDataStore, floatIconPos: pos };
    setPluginDataStore(updated);
    updatePluginDataStore(updated);
  };

  const initPluginDTableData = async () => {
    if (isDevelopment) {
      window.dtableSDK.subscribe('dtable-connect', () => {
        onDTableConnect();
      });
    }
    unsubscribeLocalDtableChanged = window.dtableSDK.subscribe('local-dtable-changed', () => {
      onDTableChanged();
    });
    unsubscribeRemoteDtableChanged = window.dtableSDK.subscribe('remote-dtable-changed', () => {
      onDTableChanged();
    });
    resetData();
  };

  let unsubscribeLocalDtableChanged = () => {
    throw new Error('Method not implemented.');
  };
  let unsubscribeRemoteDtableChanged = () => {
    throw new Error('Method not implemented.');
  };

  const onDTableConnect = () => {
    resetData();
  };
  const onDTableChanged = () => {
    resetData();
  };

  const resetData = async () => {
    let allTables: TableArray = cleanAllTables();
    let activeTable: Table = cleanActiveTable();
    let activeTableViews: TableViewArray = cleanActiveTableViews(activeTable);
    let pluginDataStore: IPluginDataStore = getPluginDataStore(activeTable, PLUGIN_NAME);
    let pluginPresets: PresetsArray = pluginDataStore.presets;

    let localActivePresetId = localStorage.getItem(ACTIVE_PRESET_ID);
    // Repair a missing OR stale active-preset id (e.g. left over from the old
    // single-preset build) by falling back to the first seeded preset.
    const isValidActive =
      !!localActivePresetId && pluginPresets.some((p) => p._id === localActivePresetId);
    if (!isValidActive) {
      localActivePresetId = pluginPresets[0]?._id ?? null;
      if (localActivePresetId) localStorage.setItem(ACTIVE_PRESET_ID, localActivePresetId);
    }
    setPluginDataStore(pluginDataStore);
    setAllTables(allTables);
    setPluginPresets(pluginPresets);
    setIsShowState((prevState) => ({ ...prevState, isLoading: false }));

    if (localActivePresetId) {
      const appActiveState = parsePluginDataToActiveState(
        pluginDataStore,
        pluginPresets,
        allTables
      );

      onSelectPreset(localActivePresetId, appActiveState);
      return;
    } else {
      if (pluginPresets.length === 0) {
        const defaultPluginDataStore: IPluginDataStore = createDefaultPluginDataStore(
          activeTable,
          PLUGIN_NAME
        );
        window.dtableSDK.updatePluginSettings(PLUGIN_NAME, defaultPluginDataStore);
      }
      const activeTableAndView: IActiveTableAndView = getActiveTableAndActiveView(
        pluginPresets,
        allTables
      );
      const activeViewRows: TableRow[] = [];

      const activeStateSafeGuard = getActiveStateSafeGuard(
        pluginPresets,
        activeTable,
        activeTableAndView,
        activeViewRows
      );

      setActiveTableViews(activeTableAndView?.table?.views || activeTableViews);
      setAppActiveState(activeStateSafeGuard);
    }
  };

  const onPluginToggle = () => {
    setTimeout(() => {
      setIsShowState((prevState) => ({ ...prevState, isShowPlugin: false }));
    }, 300);
    window.app.onClosePlugin(lang);
  };

  const onSelectPreset = (presetId: string, newPresetActiveState?: AppActiveState) => {
    localStorage.setItem(ACTIVE_PRESET_ID, presetId);

    let updatedActiveState: AppActiveState;
    let updatedActiveTableViews: TableView[];
    const _activePresetIdx = pluginPresets.findIndex((preset) => preset._id === presetId);

    if (newPresetActiveState !== undefined) {
      updatedActiveState = {
        ...newPresetActiveState,
      };
      updatedActiveTableViews = newPresetActiveState?.activeTable?.views!;
    } else {
      const activePreset = pluginPresets.find((preset) => preset._id === presetId);
      const selectedTable = activePreset?.settings?.selectedTable;
      const selectedView = activePreset?.settings?.selectedView;

      const _activeTableName = selectedTable?.label as string;
      const _activeTableId = selectedTable?.value as string;
      const _activeViewId = selectedView?.value as string;

      updatedActiveTableViews =
        allTables.find((table) => table._id === _activeTableId)?.views || [];

      updatedActiveState = {
        activeTable: allTables.find((table) => table._id === _activeTableId) || activeTable,
        activeTableName: _activeTableName,
        activeTableView:
          updatedActiveTableViews.find((view) => view._id === _activeViewId) || activeTableViews[0],
        activePresetId: presetId,
        activePresetIdx: _activePresetIdx,
      };

      updatePluginDataStore({
        ...pluginDataStore,
        activePresetId: presetId,
        activePresetIdx: _activePresetIdx,
      });
    }

    setActiveTableViews(updatedActiveTableViews);
    setAppActiveState(updatedActiveState);
  };

  const updatePresets = (
    _activePresetIdx: number,
    updatedPresets: PresetsArray,
    pluginDataStore: IPluginDataStore,
    activePresetId: string,
    callBack: any = null
  ) => {
    let _pluginDataStore = {
      ...pluginDataStore,
      activePresetId: activePresetId,
      activePresetIdx: _activePresetIdx,
    };
    const updatedActiveState = (prevState: AppActiveState) => ({
      ...prevState,
      activePresetIdx: _activePresetIdx,
    });

    setAppActiveState((prevState: AppActiveState) => updatedActiveState(prevState));
    setPluginPresets(updatedPresets);
    setPluginDataStore(pluginDataStore);
    updatePluginDataStore(_pluginDataStore);
  };

  const updatePluginDataStore = (pluginDataStore: IPluginDataStore) => {
    window.dtableSDK.updatePluginSettings(PLUGIN_NAME, pluginDataStore);
  };

  const updateActiveData = () => {
    let allTables: TableArray = cleanAllTables();
    let tableOfPresetOne = pluginPresets[0].settings?.selectedTable || {
      value: allTables[0]._id,
      label: allTables[0].name,
    };
    let viewOfPresetOne = pluginPresets[0].settings?.selectedView || {
      value: allTables[0].views[0]._id,
      label: allTables[0].views[0].name,
    };
    let table = allTables.find((t) => t._id === tableOfPresetOne.value)!;
    let view = table?.views.find((v) => v._id === viewOfPresetOne.value)!;

    const newPresetActiveState: AppActiveState = {
      activePresetId: pluginPresets[0]._id,
      activePresetIdx: 0,
      activeTable: table,
      activeTableName: table.name,
      activeTableView: view,
      activeViewRows: [],
    };

    setAppActiveState(newPresetActiveState);
  };

  const toggleSettings = () => {
    if (isMobile() && isShowState.isShowPresets) {
      togglePresets();
    }

    setIsShowState((prevState) => ({ ...prevState, isShowSettings: !prevState.isShowSettings }));
  };

  const togglePresets = () => {
    if (isMobile() && isShowState.isShowSettings) {
      toggleSettings();
    }

    setIsShowState((prevState) => ({ ...prevState, isShowPresets: !prevState.isShowPresets }));
  };

  const getAccountToken = (): string => {
    // Shared across all presets — stored at store level
    return pluginDataStore.accountToken || '';
  };

  const handleSaveAccountToken = (token: string) => {
    const updatedStore = { ...pluginDataStore, accountToken: token };
    setPluginDataStore(updatedStore);
    updatePluginDataStore(updatedStore);
  };

  const getVerifyUrls = (): boolean => {
    const activePreset = pluginPresets[activePresetIdx];
    return activePreset?.customSettings?.verifyUrls ?? false;
  };

  const handleVerifyUrlsChange = (value: boolean) => {
    const updatedPresets = pluginPresets.map((preset, idx) =>
      idx === activePresetIdx
        ? { ...preset, customSettings: { ...preset.customSettings, verifyUrls: value } }
        : preset
    );
    const updatedStore = { ...pluginDataStore, presets: updatedPresets };
    setPluginPresets(updatedPresets);
    setPluginDataStore(updatedStore);
    updatePluginDataStore(updatedStore);
  };

  const getAutoRerun = (): boolean => {
    const activePreset = pluginPresets[activePresetIdx];
    return activePreset?.customSettings?.autoRerun ?? false;
  };

  const handleAutoRerunChange = (value: boolean) => {
    const updatedPresets = pluginPresets.map((preset, idx) =>
      idx === activePresetIdx
        ? { ...preset, customSettings: { ...preset.customSettings, autoRerun: value } }
        : preset
    );
    const updatedStore = { ...pluginDataStore, presets: updatedPresets };
    setPluginPresets(updatedPresets);
    setPluginDataStore(updatedStore);
    updatePluginDataStore(updatedStore);
  };

  const getAuditTableDisplay = (): AuditTableDisplayState => {
    const activePreset = pluginPresets[activePresetIdx];
    const saved = activePreset?.customSettings?.auditTableDisplay;
    if (saved) return saved;
    // Default: all tables selected.
    return {
      selectedTables: allTables.map((t) => t._id),
      isAllSelected: true,
    };
  };

  const handleAuditTableDisplayChange = (display: AuditTableDisplayState) => {
    const updatedPresets = pluginPresets.map((preset, idx) =>
      idx === activePresetIdx
        ? { ...preset, customSettings: { ...preset.customSettings, auditTableDisplay: display } }
        : preset
    );
    const updatedStore = { ...pluginDataStore, presets: updatedPresets };
    setPluginPresets(updatedPresets);
    setPluginDataStore(updatedStore);
    updatePluginDataStore(updatedStore);
  };

  if (!isShowPlugin) {
    return null;
  }

  return isLoading ? (
    <div></div>
  ) : (
    <ResizableWrapper floating={floating}>
      {/* Kept MOUNTED (display:none) while floating so in-progress step state —
          e.g. the automation stepper's current stage — survives shrink/restore. */}
      <div style={{ display: floating ? 'none' : 'contents' }}>
        {/* presets  */}
        <PluginPresets
          appActiveState={appActiveState}
          allTables={allTables}
          pluginPresets={pluginPresets}
          activePresetIdx={activePresetIdx}
          pluginDataStore={pluginDataStore}
          isShowPresets={isShowPresets}
          onTogglePresets={togglePresets}
          onToggleSettings={toggleSettings}
          onSelectPreset={onSelectPreset}
          updatePresets={updatePresets}
          updateActiveData={updateActiveData}
          isShowState={isShowState}
          setIsShowState={setIsShowState}
          courses={courses}
          activeCourseId={activeCourseId}
          activeStepId={activeStepId}
          onSelectStep={onSelectStep}
          compact={compact}
          onFloat={onFloat}
        />
        <div className={styles.plugin} style={{ flex: 1, width: 'auto', minWidth: 0 }}>
          <Header
            presetName={findPresetName(pluginPresets, activePresetId)}
            stepTitle={activeStep?.title}
            controls={floatControls}
            isShowPresets={isShowPresets}
            isShowSettings={isShowSettings}
            onTogglePresets={togglePresets}
            toggleSettings={toggleSettings}
            togglePlugin={onPluginToggle}
            onFloat={onFloat}
          />
          {/* main body  */}
          <div
            className="d-flex position-relative"
            style={{ height: 'calc(100% - 50px)', width: '100%', backgroundColor: '#f5f5f5' }}>
            <div
              id={PLUGIN_NAME}
              className={styles.body}
              style={{ padding: '10px', flex: '1', minWidth: 0 }}>
              <CustomPlugin
                appActiveState={appActiveState}
                allTables={allTables}
                pluginDataStore={pluginDataStore}
                verifyUrls={getVerifyUrls()}
                auditTableDisplay={getAuditTableDisplay()}
                autoRerun={getAutoRerun()}
                onPerfRunningChange={setPerfRunning}
                courseManifest={activeManifest}
                courseStepId={activeStepId}
                onSelectStep={(stepId) => onSelectStep(activeCourseId, stepId)}
                onFloatControls={reportFloatControls}
                onRequestFloat={onFloat}
                onContentHeight={reportContentHeight}
              />
            </div>

            <PluginSettings
              allTables={allTables}
              appActiveState={appActiveState}
              activeTableViews={activeTableViews}
              pluginPresets={pluginPresets}
              isShowSettings={isShowSettings}
              onToggleSettings={toggleSettings}
              onSaveAccountToken={handleSaveAccountToken}
              accountToken={getAccountToken()}
              verifyUrls={getVerifyUrls()}
              onVerifyUrlsChange={handleVerifyUrlsChange}
              auditTableDisplay={getAuditTableDisplay()}
              onAuditTableDisplayChange={handleAuditTableDisplayChange}
              autoRerun={getAutoRerun()}
              onAutoRerunChange={handleAutoRerunChange}
              perfRunning={perfRunning}
            />
          </div>
        </div>
      </div>
      {floating && (
        <FloatToolbar
          pos={floatPos}
          onMove={saveFloatPos}
          onExpand={onRestoreFromFloat}
          controls={floatControls}
        />
      )}
    </ResizableWrapper>
  );
};

// The floating toolbar: a small draggable pill that replaces the whole plugin
// window while the learner works in the base (see setPluginFloating — the host is
// click-through, only this toolbar is interactive). It keeps the learner able to
// read the instruction, go back, and VERIFY the step without re-expanding — the
// actions come from the runner via `controls` (FloatControls). The plugin icon is
// branding only; the drag handle moves it; the expand icon reopens the full plugin.
const ICON_GREEN = '#10b981'; // matches the plugin icon's background

const FloatToolbar: React.FC<{
  pos: { x: number; y: number };
  onMove: (pos: { x: number; y: number }) => void;
  onExpand: () => void;
  controls: FloatControls | null;
}> = ({ pos, onMove, onExpand, controls }) => {
  const [infoOpen, setInfoOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Surface a check result immediately: pop the instruction/feedback open when one
  // arrives (pass or fail), so the learner sees it without tapping the info icon.
  const fbText = controls?.feedback?.text;
  useEffect(() => {
    if (fbText) setInfoOpen(true);
  }, [fbText]);
  // When we LAND on a step that needs checking (its primary is "verify"), re-open
  // the instruction — e.g. right after tapping Next/Next-stage — so the learner
  // always sees what to do on the new step, not just after a failed check.
  const instruction = controls?.instruction;
  const needsCheck = controls?.primary?.icon === 'check';
  useEffect(() => {
    if (needsCheck) setInfoOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instruction]);
  // Close the primary dropdown whenever the step's actions change under it.
  const primaryTitle = controls?.primary?.title;
  useEffect(() => {
    setMenuOpen(false);
  }, [primaryTitle]);

  // Drag (from the drag handle only) — moves the modal element directly for
  // smoothness, then persists the resting position on drop.
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = pos.x;
    const originY = pos.y;
    const onMouseMove = (ev: MouseEvent) =>
      setPluginFloating(originX + ev.clientX - startX, originY + ev.clientY - startY);
    const onMouseUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      const nx = Math.max(
        0,
        Math.min(originX + (ev.clientX - startX), window.innerWidth - FLOAT_W)
      );
      const ny = Math.max(
        0,
        Math.min(originY + (ev.clientY - startY), window.innerHeight - FLOAT_H)
      );
      onMove({ x: nx, y: ny });
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  // Popover placement: keyed off the RESTING position so it settles once on drop.
  const onRight = pos.x > window.innerWidth / 2;
  const onBottom = pos.y > window.innerHeight / 2;

  const primary = controls?.primary;
  const primaryGlyph =
    primary?.icon === 'check'
      ? 'dtable-icon-check-mark'
      : primary?.icon === 'run'
        ? 'dtable-icon-refresh'
        : 'dtable-icon-right';
  const primaryFailed =
    controls?.feedback?.kind === 'fail' || controls?.feedback?.kind === 'missing';

  return (
    <div style={{ position: 'relative', width: FLOAT_W, height: FLOAT_H }}>
      <div style={tb.bar}>
        <img src={pluginIcon} alt="" draggable={false} style={tb.logo} />
        <i
          className="dtable-font dtable-icon-drag"
          title="Drag to move it"
          onMouseDown={startDrag}
          style={tb.drag}
        />
        <span style={tb.divider} />
        <button
          type="button"
          style={tb.btn}
          title="Show the instruction"
          onClick={() => {
            setMenuOpen(false);
            setInfoOpen((v) => !v);
          }}>
          <i className="dtable-font dtable-icon-info" style={tb.glyph} />
        </button>
        <button
          type="button"
          style={{ ...tb.btn, ...(controls?.onBack ? null : tb.btnOff) }}
          title="Back"
          disabled={!controls?.onBack}
          onClick={controls?.onBack}>
          <i className="dtable-font dtable-icon-left" style={tb.glyph} />
        </button>
        {primary && (
          <button
            type="button"
            style={{
              ...tb.btn,
              ...(primary.menu ? tb.btnWide : null),
              ...(primaryFailed ? tb.btnFail : null),
              ...(primary.busy || primary.disabled ? tb.btnOff : null),
            }}
            title={primary.busy ? 'Checking…' : primary.title}
            disabled={primary.busy || primary.disabled}
            onClick={() => {
              if (!primary.menu) return primary.onClick();
              setInfoOpen(false);
              setMenuOpen((v) => !v);
            }}>
            <i className={`dtable-font ${primaryGlyph}`} style={tb.glyph} />
            {primary.menu && <i className="dtable-font dtable-icon-drop-down" style={tb.caret} />}
          </button>
        )}
        <button type="button" style={tb.btn} title="Reopen the course" onClick={onExpand}>
          <i className="dtable-font dtable-icon-full-screen" style={tb.glyph} />
        </button>
      </div>
      {menuOpen && primary?.menu && (
        <div
          style={{
            ...tb.popover,
            ...tb.menu,
            ...(onBottom ? { bottom: FLOAT_H + 8 } : { top: FLOAT_H + 8 }),
            ...(onRight ? { right: 0 } : { left: 0 }),
          }}>
          {primary.menu.map((opt) => (
            <button
              key={opt.label}
              type="button"
              style={tb.menuItem}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.14)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => {
                setMenuOpen(false);
                opt.onClick();
              }}>
              {opt.label}
            </button>
          ))}
        </div>
      )}
      {infoOpen && controls && (controls.instruction || controls.feedback) && (
        <div
          style={{
            ...tb.popover,
            ...(onBottom ? { bottom: FLOAT_H + 8 } : { top: FLOAT_H + 8 }),
            ...(onRight ? { right: 0 } : { left: 0 }),
          }}>
          <button
            type="button"
            style={tb.popClose}
            title="Close"
            onClick={() => setInfoOpen(false)}>
            <i className="dtable-font dtable-icon-x" style={{ fontSize: 11 }} />
          </button>
          {controls.instruction && <div style={tb.popText}>{controls.instruction}</div>}
          {controls.help && (
            <div style={tb.hintWrap}>
              <button type="button" style={tb.hintToggle} onClick={controls.help.toggle}>
                {controls.help.shown ? '▾ Hide hint' : '▸ Show hint'}
              </button>
              {controls.help.shown && <div style={tb.hintText}>{controls.help.text}</div>}
            </div>
          )}
          {controls.feedback && (
            <div style={{ ...tb.fb, ...fbColor(controls.feedback.kind) }}>
              {controls.feedback.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function fbColor(kind: NonNullable<FloatControls['feedback']>['kind']): React.CSSProperties {
  if (kind === 'pass') return { color: '#34d399' };
  if (kind === 'fail' || kind === 'missing') return { color: '#f87171' };
  return { color: '#93c5fd' };
}

const tb: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    width: '100%',
    height: '100%',
    boxSizing: 'border-box',
    padding: '0 6px 0 4px',
    background: ICON_GREEN,
    borderRadius: 12,
    boxShadow: '0 3px 10px rgba(0,0,0,0.3)',
    userSelect: 'none',
  },
  logo: { width: 28, height: 28, borderRadius: 8, display: 'block', flexShrink: 0 },
  drag: { color: 'rgba(255,255,255,0.85)', fontSize: 16, cursor: 'grab', padding: '0 3px' },
  divider: {
    width: 1,
    height: 22,
    background: 'rgba(255,255,255,0.3)',
    margin: '0 3px',
    flexShrink: 0,
  },
  btn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    padding: 0,
    flexShrink: 0,
    background: 'transparent',
    border: 'none',
    borderRadius: 8,
    color: '#fff',
    cursor: 'pointer',
  },
  btnOff: { opacity: 0.4, cursor: 'default' },
  btnFail: { background: '#ef4444' },
  btnWide: { width: 'auto', padding: '0 6px', gap: 1 },
  glyph: { fontSize: 16, lineHeight: 1 },
  caret: { fontSize: 12, lineHeight: 1, marginLeft: -1 },
  popover: {
    position: 'absolute',
    width: FLOAT_W,
    maxWidth: '80vw',
    boxSizing: 'border-box',
    background: 'rgba(17,24,39,0.95)',
    color: '#fff',
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 13,
    lineHeight: 1.4,
    boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
    zIndex: 10,
  },
  popClose: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: 18,
    height: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    background: 'transparent',
    border: 'none',
    borderRadius: 4,
    color: 'rgba(255,255,255,0.7)',
    cursor: 'pointer',
  },
  popText: { paddingRight: 14 },
  hintWrap: { marginTop: 6 },
  hintToggle: {
    padding: 0,
    background: 'transparent',
    border: 'none',
    color: '#93c5fd',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  hintText: {
    marginTop: 4,
    padding: '6px 8px',
    borderRadius: 6,
    background: 'rgba(255,255,255,0.1)',
    color: '#e5e7eb',
    fontSize: 12.5,
    lineHeight: 1.4,
  },
  // No bold: the symbol says pass or fail. The colour stays — on this dark popup an
  // info line has no symbol, and colour is what tells it from the instruction.
  fb: { marginTop: 6, paddingRight: 14 },
  menu: { padding: 4, display: 'flex', flexDirection: 'column', gap: 2, zIndex: 11 },
  menuItem: {
    textAlign: 'left',
    padding: '7px 10px',
    background: 'transparent',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    fontSize: 13,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
};

export default App;
