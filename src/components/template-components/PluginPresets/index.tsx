import React, { useEffect, useRef, useState } from 'react';
import { getTableByName } from 'dtable-utils';
import PresetItem from './PresetItem/index';
import stylesPresets from '../../../styles/template-styles/PluginPresets.module.scss';
import deepCopy from 'deep-copy';
import icon from '../../../plugin-config/icon.png';
import Preset from '../../../model/preset';
import {
  IPresetsProps,
  PresetSettings,
  PresetsArray,
} from '../../../utils/template-interfaces/PluginPresets/Presets.interface';
import {
  appendPresetSuffix,
  cleanAllTables,
  createDefaultPresetSettings,
  generatorPresetId,
  getActiveTableAndActiveView,
  isUniquePresetName,
} from '../../../utils/template-utils/utils';
import { isStepDone, PROGRESS_EVENT } from '../../../utils/custom-utils/courseStore';
import {
  ACTIVE_PRESET_ID,
  DEFAULT_PLUGIN_DATA,
  PLUGIN_NAME,
  PresetHandleAction,
  TABLE_NAME,
} from '../../../utils/template-constants';
import {
  IActiveTableAndView,
  TableArray,
  TableColumn,
} from '../../../utils/template-interfaces/Table.interface';
import PresetInput from './PresetInput';
import useClickOut from '../../../hooks/useClickOut';
import { AppActiveState } from '../../../utils/template-interfaces/App.interface';
import { HiChevronDown, HiChevronRight, HiOutlineChevronDoubleLeft } from 'react-icons/hi2';
import intl from 'react-intl-universal';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from '../../../locale';
const { [DEFAULT_LOCALE]: d } = AVAILABLE_LOCALES;

const PluginPresets: React.FC<IPresetsProps> = ({
  appActiveState,
  allTables,
  pluginPresets,
  activePresetIdx,
  pluginDataStore,
  isShowPresets,
  onTogglePresets,
  onToggleSettings,
  onSelectPreset,
  updatePresets,
  updateActiveData,
  isShowState,
  setIsShowState,
  courses,
  activeCourseId,
  activeStepId,
  onSelectStep,
  compact,
  onFloat,
}) => {
  const [presetName, setPresetName] = useState('');
  // Redraw the step checkmarks whenever a step is marked done or started over.
  const [, setProgressTick] = useState(0);
  useEffect(() => {
    const bump = () => setProgressTick((n) => n + 1);
    window.addEventListener(PROGRESS_EVENT, bump);
    return () => window.removeEventListener(PROGRESS_EVENT, bump);
  }, []);
  const [presetNameAlreadyExists, setPresetNameAlreadyExists] = useState(false);
  const [_pluginPresets, setPluginPresets] = useState<PresetsArray>([]);
  const [showNewPresetPopUp, setShowNewPresetPopUp] = useState<boolean>(false);
  const [showEditPresetPopUp, setShowEditPresetPopUp] = useState<boolean>(false);
  // Left-panel tree: accordion — one course expanded at a time, defaulting to the
  // active course. The chevron toggles; selecting a course also opens it.
  const [openCourseId, setOpenCourseId] = useState<string>(activeCourseId ?? '');
  useEffect(() => {
    if (activeCourseId) setOpenCourseId(activeCourseId);
  }, [activeCourseId]);
  const toggleOpen = (id: string) => setOpenCourseId((cur) => (cur === id ? '' : id));
  const handleSelectPreset = (presetId: string, st?: AppActiveState) => {
    onSelectPreset(presetId, st);
    setOpenCourseId(presetId);
    // Clicking a course TITLE jumps to that course's first (introduction) step — a
    // full course page — so from a compact exercise view the plugin expands again
    // and the whole nav tree comes back. (Its step rows still navigate per step.)
    const manifest = courses?.find((c) => c.courseId === presetId);
    const first = manifest?.steps[0];
    if (first && onSelectStep) onSelectStep(presetId, first.id);
  };

  // Keep the current step visible when the panel is short (compact/exercise view).
  const activeStepRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeStepRef.current?.scrollIntoView({ block: 'nearest' });
  }, [compact, activeStepId, activeCourseId, openCourseId]);

  useEffect(() => {
    setPluginPresets(pluginPresets);
  }, [pluginPresets]);

  const getSelectedTable = (tables: TableArray, settings: any = {}) => {
    let selectedTable = getTableByName(settings[TABLE_NAME]);
    if (!selectedTable) {
      return tables[0];
    }
    return selectedTable;
  };

  const initPresetSetting = (settings = {}) => {
    let initUpdated = {};
    let tables = cleanAllTables();
    let selectedTable = getSelectedTable(tables, settings);
    let titleColumn = selectedTable.columns.find((column: TableColumn) => column.key === '0000');
    let imageColumn = selectedTable.columns.find((column: TableColumn) => column.type === 'image');
    let imageName = imageColumn ? imageColumn.name : null;
    let titleName = titleColumn ? titleColumn.name : null;
    initUpdated = Object.assign(
      {},
      { shown_image_name: imageName },
      { shown_title_name: titleName }
    );
    return initUpdated;
  };

  // handle preset name change
  const onChangePresetName = (e: React.FormEvent<HTMLInputElement>, type?: string) => {
    setPresetNameAlreadyExists(false);
    if (e.currentTarget.value.includes('  ')) {
      return;
    } else {
      setPresetName(e.currentTarget.value);
      onNewPresetSubmit(e, e.currentTarget.value, type);
    }
  };

  useClickOut(() => {
    setPresetNameAlreadyExists(false);
  });

  // Submit new/edited preset name
  const onNewPresetSubmit = (
    e: React.FormEvent<HTMLInputElement>,
    __presetName: string,
    type?: string
  ) => {
    let _presetName =
      __presetName.trim() ||
      presetName.trim() ||
      DEFAULT_PLUGIN_DATA.presets[0].name + ' ' + _pluginPresets.length;
    let _presetNames = _pluginPresets.map((p) => p.name);
    const isUnique = isUniquePresetName(_presetName, _pluginPresets, activePresetIdx);

    if (isUnique && type === PresetHandleAction.new) {
      _presetName = appendPresetSuffix(_presetName, _presetNames, 'new');
      setPresetNameAlreadyExists(false);
    } else if (isUnique) {
      setPresetNameAlreadyExists(true);
      return;
    }

    if (type === PresetHandleAction.edit) {
      editPreset(_presetName);
    } else {
      addPreset(type || PresetHandleAction.new, _presetName);
      setShowNewPresetPopUp(false);
    }

    setPresetName(intl.get('preset_new'));
    setShowEditPresetPopUp(type === PresetHandleAction.edit ? false : true);
  };

  // Toggle input field for add/edit preset
  const togglePresetsUpdate = (e?: React.MouseEvent<HTMLElement>, type?: string) => {
    if (type === PresetHandleAction.edit) {
      const presetName = pluginPresets[activePresetIdx]?.name;
      setPresetName(presetName);
      setShowEditPresetPopUp((prev) => !prev);
    } else {
      setPresetName(intl.get('preset_new'));
      setShowNewPresetPopUp((prev) => !prev);
    }
  };

  // add new/duplicate preset
  const addPreset = (
    type: string,
    presetName: string,
    option?: { pId: string; pSettings: PresetSettings }
  ) => {
    let _presetSettings: PresetSettings =
      type === PresetHandleAction.new
        ? createDefaultPresetSettings(allTables)
        : type === PresetHandleAction.duplicate && option?.pSettings
          ? option.pSettings
          : {};

    setPluginPresets(_pluginPresets || []);
    let _activePresetIdx = _pluginPresets?.length;
    let _id: string = generatorPresetId(pluginPresets) || '';
    localStorage.setItem(ACTIVE_PRESET_ID, _id);
    let newPreset = new Preset({ _id, name: presetName });
    let newPresetsArray = deepCopy(_pluginPresets);
    newPresetsArray.push(newPreset);
    let initUpdated = initPresetSetting();
    newPresetsArray[_activePresetIdx].settings = Object.assign(_presetSettings, initUpdated);
    pluginDataStore.presets = newPresetsArray;
    updatePresets(_activePresetIdx, newPresetsArray, pluginDataStore, _id);
    const _activeTableAndView: IActiveTableAndView = getActiveTableAndActiveView(
      newPresetsArray,
      allTables,
      type,
      option
    );

    // Update active state info
    const newPresetActiveState: AppActiveState = {
      activePresetId: _id,
      activePresetIdx: _activePresetIdx,
      activeTable: _activeTableAndView.table,
      activeTableName: newPresetsArray[_activePresetIdx]?.settings?.selectedTable?.label!,
      activeTableView: _activeTableAndView.view,
    };

    onSelectPreset(_id, newPresetActiveState);
  };

  // Duplicate a preset
  const duplicatePreset = (p: any) => {
    // anytofix
    const { name, _id, settings } = p;
    let _presetNames = _pluginPresets.map((p) => p.name);
    let _presetName = appendPresetSuffix(name, _presetNames, 'copy');
    addPreset(PresetHandleAction.duplicate, _presetName, { pId: _id, pSettings: settings });
  };

  // edit preset name
  const editPreset = (presetName: string) => {
    let newPluginPresets = deepCopy(pluginPresets);
    let oldPreset = pluginPresets[activePresetIdx];
    let _id: string = generatorPresetId(pluginPresets) || '';
    let updatedPreset = new Preset({ ...oldPreset, _id, name: presetName });
    localStorage.setItem(ACTIVE_PRESET_ID, _id);

    newPluginPresets.splice(activePresetIdx, 1, updatedPreset);
    pluginDataStore.presets = newPluginPresets;

    updatePresets(activePresetIdx, newPluginPresets, pluginDataStore, _id);
  };

  // Delete the selected Preset
  const deletePreset = () => {
    let newPluginPresets = deepCopy(pluginPresets);
    newPluginPresets.splice(activePresetIdx, 1);
    if (activePresetIdx >= newPluginPresets.length) {
      activePresetIdx = newPluginPresets.length - 1;
    }
    pluginDataStore.presets = newPluginPresets;
    localStorage.setItem(ACTIVE_PRESET_ID, newPluginPresets[0]._id);
    updatePresets(0, newPluginPresets, pluginDataStore, pluginDataStore.presets[0]._id);
  };

  const downloadImage = (dataUrl: string, fileName: string) => {
    const a = document.createElement('a');

    a.setAttribute('download', fileName + '.png');
    a.setAttribute('href', dataUrl);
    a.click();
    setIsShowState({ ...isShowState, isShowWaiting: false });
    // TODO: add FileSaver ?
  };

  // Rerun audit: preserve settings (like accountToken) but trigger a rerun
  const resetPreset = () => {
    let newPluginPresets = deepCopy(pluginPresets);
    const oldPreset = pluginPresets[activePresetIdx];
    newPluginPresets[activePresetIdx] = {
      ...oldPreset,
      customSettings: {
        ...oldPreset.customSettings,
        rerunAt: Date.now(),
      },
    };
    pluginDataStore.presets = newPluginPresets;
    updatePresets(activePresetIdx, newPluginPresets, pluginDataStore, oldPreset._id);
  };

  // Export the selected Preset
  const exportPreset = () => {
    // TODO: Implement export functionality for your custom plugin
  };

  // v0: drag-and-drop reordering removed — single fixed course preset.

  return (
    <div
      className={`${stylesPresets.presets}  ${!isShowPresets && stylesPresets.presets_collapsed}`}
      style={{ height: '100%' }}>
      <button onClick={onTogglePresets} className={stylesPresets.presets_collapse_btn}>
        <HiOutlineChevronDoubleLeft />
      </button>
      <div className="d-flex flex-column" style={{ height: '100%', minHeight: 0 }}>
        <div className={`d-flex align-items-center py-2 pb-4 ${stylesPresets.presets_logo}`}>
          <img
            src={icon}
            alt="Plugin Icon"
            className={stylesPresets.presets_icon}
            onClick={onFloat}
            title={onFloat ? 'Shrink to a movable icon' : undefined}
            style={onFloat ? { cursor: 'pointer' } : undefined}
          />
          <div className={stylesPresets.presets_name}>{PLUGIN_NAME}</div>
        </div>
        {/* Scrollable course list, so the current step stays reachable when the
            plugin window is short (compact/exercise view). Each course preset is a
            level-1 tree node; its manifest steps render as level-2 children (the
            in-plugin navigation that replaces the dead `qid` URL deep-link). In
            compact mode only the active course is shown (auto-scrolled to the
            current step). */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {pluginPresets?.map((preset, i) => {
            if (compact && preset._id !== activeCourseId) return null;
            const manifest = courses?.find((c) => c.courseId === preset._id);
            const steps = manifest?.steps ?? [];
            const showTree = steps.length > 0 && !!onSelectStep;
            // The "follow the rest on the website" caption only makes sense for a
            // course whose steps actually hand off to the website (course 4), not
            // the fully in-plugin Welcome tour or intro-only external courses.
            const hasWebsiteSteps = steps.some((s) => s.continuesOn === 'website');
            const expanded = compact ? true : openCourseId === preset._id;
            const isActiveCourse = preset._id === activeCourseId;
            return (
              <div key={preset._id}>
                <div style={treeStyles.courseRow}>
                  {!compact && (
                    <button
                      type="button"
                      onClick={() => showTree && toggleOpen(preset._id)}
                      disabled={!showTree}
                      style={{
                        ...treeStyles.chevronBtn,
                        ...(showTree ? null : treeStyles.chevronHidden),
                      }}
                      aria-label={expanded ? 'Collapse course' : 'Expand course'}>
                      {showTree && (expanded ? <HiChevronDown /> : <HiChevronRight />)}
                    </button>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <PresetItem
                      p={preset}
                      activePresetIdx={activePresetIdx}
                      presetName={presetName}
                      pluginPresets={pluginPresets}
                      presetNameAlreadyExists={presetNameAlreadyExists && activePresetIdx === i}
                      onChangePresetName={(e: React.FormEvent<HTMLInputElement>) =>
                        onChangePresetName(e, PresetHandleAction.edit)
                      }
                      onSelectPreset={handleSelectPreset}
                      deletePreset={deletePreset}
                      exportPreset={exportPreset}
                      resetPreset={resetPreset}
                      duplicatePreset={duplicatePreset}
                      togglePresetsUpdate={togglePresetsUpdate}
                      showEditPresetPopUp={showEditPresetPopUp}
                      onToggleSettings={onToggleSettings}
                      isShowState={isShowState}
                      setIsShowState={setIsShowState}
                    />
                  </div>
                </div>
                {showTree && expanded && (
                  <div style={treeStyles.stepsWrap}>
                    {hasWebsiteSteps && (
                      <div style={treeStyles.stepsCaption}>
                        Plugin checkpoints — follow the rest of the course on the website
                      </div>
                    )}
                    {steps.map((s) => {
                      const active = isActiveCourse && s.id === activeStepId;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          ref={active ? activeStepRef : undefined}
                          onClick={() => onSelectStep!(preset._id, s.id)}
                          style={{
                            ...treeStyles.stepRow,
                            ...(active ? treeStyles.stepRowActive : null),
                          }}>
                          {/* Where the learner stands, at a glance: a check for a step that
                              is done, a plain dot otherwise. (The dot used to encode the
                              page TYPE — orange exercise, grey lesson — which told the
                              learner nothing they needed.) */}
                          {isStepDone(preset._id, s) ? (
                            <i
                              className="dtable-font dtable-icon-check-mark"
                              style={treeStyles.stepCheck}
                              aria-label="done"
                            />
                          ) : (
                            <span style={treeStyles.stepDot} />
                          )}
                          <span style={treeStyles.stepTitle}>{s.title}</span>
                          {/* Only exercises are marked: they are the pages that shrink the
                              panel to a banner, and marking every page would crowd the list. */}
                          {s.type === 'exercise' && (
                            <i
                              className="dtable-font dtable-icon-rename"
                              style={treeStyles.stepExercise}
                              title="Exercise — the panel shrinks so you can work in your base"
                              aria-label="exercise"
                            />
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {/* add new preset input  */}
          {showNewPresetPopUp && (
            <PresetInput
              onChangePresetName={(e: React.FormEvent<HTMLInputElement>) =>
                onChangePresetName(e, PresetHandleAction.new)
              }
              isEditing={showNewPresetPopUp}
              setIsEditing={setShowNewPresetPopUp}
              presetName={presetName}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// Level-2 navigation-tree styling. The sidebar background is dark navy
// ($preset-bgColor rgb(29,40,56)), so text/markers are light.
const treeStyles: Record<string, React.CSSProperties> = {
  courseRow: { display: 'flex', alignItems: 'stretch' },
  chevronBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    padding: 0,
    background: 'transparent',
    border: 'none',
    color: '#b0b7c3',
    cursor: 'pointer',
    fontSize: 15,
  },
  chevronHidden: { cursor: 'default', color: 'transparent' },
  stepsWrap: { display: 'flex', flexDirection: 'column', margin: '2px 8px 8px 40px' },
  stepsCaption: {
    color: '#8a94a6',
    fontSize: 11,
    lineHeight: 1.4,
    fontStyle: 'italic',
    padding: '0 10px 6px',
  },
  stepRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    background: 'transparent',
    border: 'none',
    borderRadius: 4,
    color: '#d5d8dd',
    cursor: 'pointer',
    textAlign: 'left',
    fontSize: 13,
    width: '100%',
  },
  stepRowActive: { background: 'rgba(255,255,255,0.14)', color: '#fff', fontWeight: 600 },
  stepDot: {
    width: 6,
    height: 6,
    margin: '0 2px',
    borderRadius: '50%',
    flexShrink: 0,
    background: '#8a94a6',
  },
  stepCheck: { width: 10, fontSize: 10, color: '#34d399', flexShrink: 0, textAlign: 'center' },
  stepTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  stepExercise: { marginLeft: 'auto', fontSize: 10, opacity: 0.6, flexShrink: 0 },
};

export default PluginPresets;
