import React, { useEffect, useRef, useState } from 'react';
import PresetItem from './PresetItem/index';
import stylesPresets from '../../../styles/template-styles/PluginPresets.module.scss';
import icon from '../../../plugin-config/icon.png';
import { IPresetsProps } from '../../../utils/template-interfaces/PluginPresets/Presets.interface';
import { isStepDone, PROGRESS_EVENT } from '../../../utils/custom-utils/courseStore';
import { pluginDisplayName } from '../../../utils/template-constants';
import { HiChevronDown, HiChevronRight, HiOutlineChevronDoubleLeft } from 'react-icons/hi2';
import { t } from '../../../locale/t';

// The left-hand panel: the fixed list of courses (COURSES, courseContent.ts), each
// expanding to its steps. The names still say "presets": the plugin template it grew
// from listed user-made presets here, and the component kept its place in the layout.
const PluginPresets: React.FC<IPresetsProps> = ({
  pluginPresets,
  isShowPresets,
  onTogglePresets,
  onSelectPreset,
  courses,
  activeCourseId,
  activeStepId,
  onSelectStep,
  compact,
  onFloat,
}) => {
  // Redraw the step checkmarks whenever a step is marked done or started over.
  const [, setProgressTick] = useState(0);
  useEffect(() => {
    const bump = () => setProgressTick((n) => n + 1);
    window.addEventListener(PROGRESS_EVENT, bump);
    return () => window.removeEventListener(PROGRESS_EVENT, bump);
  }, []);
  // Left-panel tree: accordion — one course expanded at a time, defaulting to the
  // active course. The chevron toggles; selecting a course also opens it.
  const [openCourseId, setOpenCourseId] = useState<string>(activeCourseId ?? '');
  useEffect(() => {
    if (activeCourseId) setOpenCourseId(activeCourseId);
  }, [activeCourseId]);
  const toggleOpen = (id: string) => setOpenCourseId((cur) => (cur === id ? '' : id));
  const handleSelectPreset = (presetId: string) => {
    onSelectPreset(presetId);
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

  return (
    <div
      className={`${stylesPresets.presets}  ${isShowPresets ? '' : stylesPresets.presets_collapsed}`}
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
            title={onFloat ? t('courses.shrink_icon') : undefined}
            style={onFloat ? { cursor: 'pointer' } : undefined}
          />
          <div className={stylesPresets.presets_name}>{pluginDisplayName()}</div>
        </div>
        {/* Scrollable course list, so the current step stays reachable when the
            plugin window is short (compact/exercise view). Each course preset is a
            level-1 tree node; its manifest steps render as level-2 children (the
            in-plugin navigation that replaces the dead `qid` URL deep-link). In
            compact mode only the active course is shown (auto-scrolled to the
            current step). */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {pluginPresets?.map((preset) => {
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
                      aria-label={expanded ? t('courses.collapse') : t('courses.expand')}>
                      {showTree && (expanded ? <HiChevronDown /> : <HiChevronRight />)}
                    </button>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <PresetItem
                      p={preset}
                      active={isActiveCourse}
                      onSelectPreset={handleSelectPreset}
                    />
                  </div>
                </div>
                {showTree && expanded && (
                  <div style={treeStyles.stepsWrap}>
                    {hasWebsiteSteps && (
                      <div style={treeStyles.stepsCaption}>{t('courses.checkpoints_caption')}</div>
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
                              aria-label={t('courses.done')}
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
                              title={t('courses.exercise_title')}
                              aria-label={t('courses.exercise')}
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
