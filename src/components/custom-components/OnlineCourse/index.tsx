import React, { useEffect, useRef, useState } from 'react';
import { learnerAppendRows, learnerUpdateRow } from '../../../utils/custom-utils/learnerWrite';
import {
  CourseManifest,
  CourseStep,
  fetchStepHtml,
  findStep,
  stepIndex,
} from '../../../utils/custom-utils/courseContent';
import { AutomationRuleRule, Outcome } from '../../../utils/custom-utils/grader';
import { gradeStep } from '../../../utils/custom-utils/opLogGrade';
import { gradeAutomationRule } from '../../../utils/custom-utils/automationGrade';
import { FloatControls } from '../../../utils/custom-interfaces/FloatControls';

/**
 * Online courses plugin — manifest-driven runner (Course 3 — Collaboration + others).
 *
 * The runner is CONTROLLED: the course manifest and the current step are owned by
 * App (so the left-panel navigation tree and the runner stay in sync) and passed in
 * as props. This component fetches each step's HTML, renders it, grades exercises
 * (grader.ts) and resizes the plugin window. Navigation is delegated up to
 * `onSelectStep`, which also persists progress (courseProgress.ts).
 *
 * Step types drive the layout: 'course' = full-height lesson page; 'exercise' =
 * compact bottom banner. The plugin window is height-resized to match. An exercise
 * flagged `demo: 'live-modify'` swaps the Verify flow for a scripted plugin action.
 */

// --- live-modify demo (rendered only on a `demo: 'live-modify'` exercise step) --

// The demo steps a fixed Line items row's Status through a few values (spaced out),
// so you can watch the grid update and inspect how the edits are attributed in row
// history. Each write is a clean dtable-store op via learnerUpdateRow — identical to
// a manual UI edit (singular modify_row + populated old_row, so it's restorable).
const LIVE_DEMO_TABLE = 'Line items';
const LIVE_DEMO_ROW_ID = 'LK228TKwQW-uRMzT26obqw';
const LIVE_DEMO_COLUMN = 'Status';
const LIVE_DEMO: { value: string; delayMs: number }[] = [
  { value: 'Too many', delayMs: 0 },
  { value: 'Too few', delayMs: 900 },
  { value: 'Damaged', delayMs: 900 },
];

// ----------------------------------------------------------------------------
// Plugin-window height (full lesson view vs compact exercise banner) is driven by
// App now, so the header expand/collapse toggle stays in sync — see setPluginHeight
// in app.tsx.

interface OnlineCourseProps {
  manifest: CourseManifest | null;
  stepId: string | null;
  loadNote?: string;
  onSelectStep: (stepId: string) => void;
  // Reports the current step's instruction AND its actions (back / verify / advance)
  // up to App, so the floating toolbar can drive the step without re-expanding the
  // plugin. Follows the automation stepper's sub-stage too. Must be stable.
  onFloatControls?: (controls: FloatControls) => void;
  // Reports the exercise banner's natural content height (px) so App can size the
  // plugin window to show the whole instruction/hint/result without scrolling. Must
  // be stable. Not called on full-height lesson pages.
  onContentHeight?: (px: number) => void;
}

// Strip HTML to a single line of plain text (for the floating-icon caption).
function htmlToText(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();
}

// --- forward navigation (website-unfolding handoff) -------------------------
// The website is the course spine; the plugin holds only the interactive
// checkpoints. Forward motion is driven by each step's `continuesOn`, NOT by
// manifest adjacency (the manifest is intentionally gapped) — so after a checkpoint
// the learner is handed back to the website unless the next authored step is itself
// a plugin checkpoint. `end` = nothing to advance to (e.g. an intro-only course).
type Forward =
  | { kind: 'next'; step: CourseStep }
  | { kind: 'website'; note: string }
  | { kind: 'end' };

const DEFAULT_HANDOFF = 'The next step continues on the website ↩';

function forwardFor(step: CourseStep, nextStep?: CourseStep): Forward {
  if (step.continuesOn === 'plugin' && nextStep) return { kind: 'next', step: nextStep };
  if (step.continuesOn === 'website')
    return { kind: 'website', note: step.handoffNote ?? DEFAULT_HANDOFF };
  // Unset (plugin front-matter like the Introduction): plain structural nav.
  return nextStep ? { kind: 'next', step: nextStep } : { kind: 'end' };
}

const OnlineCourse: React.FC<OnlineCourseProps> = ({
  manifest,
  stepId,
  loadNote = '',
  onSelectStep,
  onFloatControls,
  onContentHeight,
}) => {
  const [html, setHtml] = useState<string>('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [showHint, setShowHint] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // live-modify demo state
  const [demoStatus, setDemoStatus] = useState('');
  const [demoRunning, setDemoRunning] = useState(false);

  // automation-guided state: 'choice' → guided stepper or one-shot check.
  const [autoMode, setAutoMode] = useState<'choice' | 'guided' | 'check'>('choice');
  const [autoStageIdx, setAutoStageIdx] = useState(0);

  // The exercise banner's content, measured so App can size the plugin to fit.
  const bannerRef = useRef<HTMLDivElement | null>(null);

  const step: CourseStep | undefined = manifest ? findStep(manifest, stepId) : undefined;
  const mode = step?.type ?? 'course';
  const isLiveDemo = step?.demo === 'live-modify';
  const isLoadExample = step?.demo === 'load-example';
  const isAutomationGuided = step?.demo === 'automation-guided';

  // On step change: fetch its HTML, reset UI. Progress persistence and window
  // resizing both live in App — the source of truth for the active step.
  useEffect(() => {
    if (!manifest || !step || !stepId) return;
    setOutcome({ kind: 'idle' });
    setShowHint(false);
    setDemoStatus('');
    setAutoMode('choice');
    setAutoStageIdx(0);

    let cancelled = false;
    setHtml('');
    fetchStepHtml(manifest.courseId, step)
      .then((h) => !cancelled && setHtml(h))
      .catch(() => !cancelled && setHtml('<p>⚠️ Couldn’t load this page.</p>'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, manifest]);

  // --- navigation -----------------------------------------------------------
  const idx = manifest && stepId ? stepIndex(manifest, stepId) : -1;
  const nextStep = manifest && idx >= 0 ? manifest.steps[idx + 1] : undefined;
  const prevStep = manifest && idx > 0 ? manifest.steps[idx - 1] : undefined;

  const goPrev = () => prevStep && onSelectStep(prevStep.id);
  // Grading may be async (op-log rules hit the activity-log REST endpoint).
  const onVerify = async () => {
    if (!step?.grade || verifying) return;
    setVerifying(true);
    try {
      setOutcome(await gradeStep(step.grade));
    } finally {
      setVerifying(false);
    }
  };
  const passed = outcome.kind === 'pass';

  // --- live-modify demo action ----------------------------------------------
  const runLiveDemo = async () => {
    if (demoRunning) return;
    setDemoRunning(true);
    setDemoStatus('Running…');
    try {
      for (const s of LIVE_DEMO) {
        if (s.delayMs) await new Promise((res) => setTimeout(res, s.delayMs));
        await learnerUpdateRow(LIVE_DEMO_TABLE, LIVE_DEMO_ROW_ID, { [LIVE_DEMO_COLUMN]: s.value });
        setDemoStatus(`✏️ ${LIVE_DEMO_COLUMN} → ${s.value}`);
      }
      setDemoStatus(`✅ Done. Open the row's history to see how the edits are attributed.`);
    } catch (err: any) {
      setDemoStatus(`❌ ${err?.message || 'Live edit failed.'}`);
    }
    setDemoRunning(false);
  };

  // --- load-example action (AI safety net) ----------------------------------
  const runLoadExample = async () => {
    if (demoRunning || !step?.example) return;
    setDemoRunning(true);
    setDemoStatus('Loading…');
    try {
      const n = await learnerAppendRows(step.example.table_name, step.example.rows);
      setDemoStatus(`✅ Added ${n} line${n === 1 ? '' : 's'} to "${step.example.table_name}".`);
    } catch (err: any) {
      setDemoStatus(`❌ ${err?.message || 'Could not load the example.'}`);
    }
    setDemoRunning(false);
  };

  // --- automation-guided actions --------------------------------------------
  const stages = step?.automationStages || [];
  // Check one guided stage (a slice of the step's automation-rule grade).
  const verifyAutomationStage = async () => {
    if (!step?.grade || verifying) return;
    const stage = stages[autoStageIdx]?.stage ?? 'all';
    setVerifying(true);
    try {
      setOutcome(await gradeAutomationRule(step.grade as AutomationRuleRule, stage));
    } finally {
      setVerifying(false);
    }
  };
  const advanceStage = () => {
    setOutcome({ kind: 'idle' });
    setAutoStageIdx((i) => i + 1);
  };

  // Where this step hands off (an in-plugin Next, or back to the website). Guarded
  // so it's also computable while loading (for the toolbar report below).
  const forward: Forward = step ? forwardFor(step, nextStep) : { kind: 'end' };

  // Build the descriptor the header + floating toolbar render from: the current
  // instruction plus the ONE context-aware primary action and the reveal-on-demand
  // hint, so the learner can read / go back / verify / advance / get a hint WITHOUT
  // the buttons living in the body.
  const buildFloatControls = (): FloatControls => {
    const fc = baseFloatControls();
    if (step?.hint) {
      fc.help = { shown: showHint, toggle: () => setShowHint((v) => !v), text: step.hint };
    }
    return fc;
  };
  const baseFloatControls = (): FloatControls => {
    if (!step) return { instruction: '' };
    const onBack = prevStep ? goPrev : undefined;
    const text = step.instruction ?? htmlToText(html);
    // Forward after a pass: an in-plugin Next, else (website handoff) no button —
    // the closer surfaces in `feedback` instead.
    const forwardPrimary: FloatControls['primary'] | undefined =
      forward.kind === 'next'
        ? { icon: 'next', title: 'Next', onClick: () => onSelectStep(forward.step.id) }
        : undefined;
    const passFeedback = (msg?: string): FloatControls['feedback'] =>
      outcome.kind !== 'idle' ? { kind: outcome.kind, text: feedbackText(outcome, msg) } : undefined;

    // Lesson page: only a forward.
    if (step.type === 'course') return { instruction: text, onBack, primary: forwardPrimary };

    // Demo steps: the primary RUNS the scripted action; its status shows as info.
    if (isLiveDemo || isLoadExample) {
      return {
        instruction: text,
        onBack,
        primary: {
          icon: 'run',
          title: isLiveDemo ? 'Run live edits' : 'Load the example',
          onClick: isLiveDemo ? runLiveDemo : runLoadExample,
          busy: demoRunning,
        },
        feedback: demoStatus ? { kind: 'info', text: demoStatus } : undefined,
      };
    }

    // Automation-guided step: choice → check / guided stepper.
    if (isAutomationGuided) {
      if (autoMode === 'choice') {
        const guideMe = () => {
          setOutcome({ kind: 'idle' });
          setAutoStageIdx(0);
          setAutoMode('guided');
        };
        const justCheck = () => {
          setOutcome({ kind: 'idle' });
          setAutoMode('check');
        };
        return {
          instruction: text,
          onBack,
          // Mirror the choice screen's two options as a dropdown on the primary.
          primary: {
            icon: 'next',
            title: 'Build the automation',
            onClick: guideMe,
            menu: [
              { label: 'Guide me step by step', onClick: guideMe },
              { label: 'I built it — just check it', onClick: justCheck },
            ],
          },
        };
      }
      if (autoMode === 'check') {
        return {
          instruction: text,
          onBack: () => {
            setOutcome({ kind: 'idle' });
            setAutoMode('choice');
          },
          primary: passed
            ? forwardPrimary
            : { icon: 'check', title: 'Check my automation', onClick: onVerify, busy: verifying },
          feedback: passFeedback(step.successMessage),
        };
      }
      // Guided stepper.
      const stage = stages[autoStageIdx];
      const lastStage = autoStageIdx >= stages.length - 1;
      const passMsg = lastStage ? step.successMessage : 'Stage complete — on to the next.';
      let primary: FloatControls['primary'] | undefined;
      if (passed && !lastStage) primary = { icon: 'next', title: 'Next stage', onClick: advanceStage };
      else if (passed && lastStage) primary = forwardPrimary;
      else primary = { icon: 'check', title: 'Check', onClick: verifyAutomationStage, busy: verifying };
      return {
        instruction: stage?.instruction ?? htmlToText(stage?.html || ''),
        onBack: () => {
          setOutcome({ kind: 'idle' });
          if (autoStageIdx === 0) setAutoMode('choice');
          else setAutoStageIdx((i) => i - 1);
        },
        primary,
        feedback: passFeedback(passMsg),
      };
    }

    // Plain exercise.
    return {
      instruction: text,
      onBack,
      primary: passed
        ? forwardPrimary
        : { icon: 'check', title: 'Verify', onClick: onVerify, busy: verifying },
      feedback:
        passed && forward.kind === 'website'
          ? { kind: 'pass', text: `${feedbackText(outcome, step.successMessage)} ${forward.note}` }
          : passFeedback(step.successMessage),
    };
  };

  useEffect(() => {
    onFloatControls?.(buildFloatControls());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, manifest, html, autoMode, autoStageIdx, outcome, verifying, demoRunning, demoStatus, showHint]);

  // Measure the exercise banner and report its natural height, so App can size the
  // plugin to show the whole instruction/hint/result without scrolling. A
  // ResizeObserver catches every content change (hint toggle, feedback, images);
  // on lesson pages the banner isn't mounted, so nothing is reported (App keeps the
  // full-height size).
  useEffect(() => {
    const el = bannerRef.current;
    if (!el || !onContentHeight) return;
    const report = () => onContentHeight(el.scrollHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepId, mode, onContentHeight]);

  // --- render ---------------------------------------------------------------
  if (!manifest || !step) {
    return (
      <div style={S.coursePage}>
        <div style={S.courseInner}>
          <div style={{ marginBottom: 16 }}>Loading…</div>
        </div>
      </div>
    );
  }

  // Course page (full height): content only — Back/Continue live in the plugin
  // header (and the floating toolbar), driven by buildFloatControls above.
  if (mode === 'course') {
    return (
      <div style={S.coursePage}>
        <div style={S.courseInner}>
          {loadNote && <div style={S.loadNote}>{loadNote}</div>}
          <div dangerouslySetInnerHTML={{ __html: html }} />
          {forward.kind === 'website' && <div style={S.websiteHandoffBlock}>{forward.note}</div>}
        </div>
      </div>
    );
  }

  // Exercise (compact banner): content + optional stage progress / demo status /
  // hint / feedback. Every action (Back, Verify, Run, Next, the guided-build choice)
  // lives in the plugin header and the floating toolbar — see buildFloatControls.
  const guided = isAutomationGuided && autoMode === 'guided';
  const bodyHtml = guided ? stages[autoStageIdx]?.html || '' : html;
  const feedbackMsg = guided
    ? autoStageIdx >= stages.length - 1
      ? step.successMessage
      : 'Stage complete — on to the next.'
    : step.successMessage;
  const feedbackLine =
    outcome.kind === 'idle'
      ? null
      : passed && forward.kind === 'website'
        ? `${feedbackText(outcome, step.successMessage)} ${forward.note}`
        : feedbackText(outcome, feedbackMsg);

  return (
    <div style={S.banner}>
      <div style={S.bannerMain} ref={bannerRef}>
        {guided && (
          <div style={S.stageProgress}>
            {stages.map((s, i) => (
              <span key={s.stage} style={stagePillStyle(i, autoStageIdx)}>
                {i < autoStageIdx ? '✓' : `${i + 1}.`} {s.title}
              </span>
            ))}
          </div>
        )}
        <div style={S.instruction} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
        {demoStatus && <div style={S.demoStatus}>{demoStatus}</div>}
        {showHint && step.hint && <div style={S.hint}>{step.hint}</div>}
        {feedbackLine && (
          <div style={{ marginTop: 8 }}>
            <span style={feedbackStyle(outcome.kind)}>{feedbackLine}</span>
          </div>
        )}
      </div>
    </div>
  );
};

function feedbackText(o: Outcome, successMessage?: string): string {
  switch (o.kind) {
    case 'pass':
      return `✅ ${successMessage ?? 'Well done — the shared master is back in sync.'}`;
    case 'fail':
      return `❌ Not yet — ${o.reason}.`;
    case 'missing':
      return `⚠️ Couldn't find ${o.what} in the base. Check that the base matches the exercise.`;
    default:
      return '';
  }
}

// One stage "pill" in the guided stepper: done (green), current (orange), or
// upcoming (muted).
function stagePillStyle(index: number, current: number): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: '3px 9px',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
  };
  if (index < current) return { ...base, background: '#e6f5ea', color: '#1a7f37' };
  if (index === current) return { ...base, background: '#fff1e0', color: '#b45309' };
  return { ...base, background: '#f0f2f5', color: '#8a94a2' };
}

function feedbackStyle(kind: Outcome['kind']): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block',
    padding: '6px 10px',
    borderRadius: 6,
    fontSize: 14,
    fontWeight: 600,
  };
  if (kind === 'pass') return { ...base, background: '#e6f5ea', color: '#1a7f37' };
  if (kind === 'fail') return { ...base, background: '#fdecec', color: '#c0392b' };
  return { ...base, background: '#fef6e0', color: '#9a6700' };
}

const S: Record<string, React.CSSProperties> = {
  coursePage: { height: '100%', overflowY: 'auto', background: '#fff' },
  courseInner: { maxWidth: 720, margin: '0 auto', padding: '32px 24px' },
  loadNote: {
    marginBottom: 16,
    padding: '6px 10px',
    borderRadius: 6,
    fontSize: 12,
    background: '#fef6e0',
    color: '#9a6700',
  },
  demoStatus: { marginTop: 8, fontSize: 13, color: '#333' },
  // "Continue on the website" closer (website-unfolding handoff), under a full page.
  websiteHandoffBlock: {
    marginTop: 12,
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 14,
    background: '#eef1f5',
    color: '#556070',
    border: '1px solid #d6dbe2',
  },
  banner: {
    height: '100%',
    boxSizing: 'border-box',
    overflowY: 'auto',
    background: '#fff',
    padding: '12px 18px',
  },
  bannerMain: { minWidth: 0 },
  stageProgress: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  instruction: { fontSize: 15, lineHeight: 1.5, color: '#222' },
  hint: {
    marginTop: 8,
    padding: '8px 12px',
    borderRadius: 6,
    fontSize: 14,
    background: '#eef4ff',
    color: '#1c4e80',
  },
};

export default OnlineCourse;
