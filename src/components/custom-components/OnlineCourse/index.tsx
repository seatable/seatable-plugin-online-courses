import React, { useEffect, useState } from 'react';
import { learnerAppendRows, learnerUpdateRow } from '../../../utils/custom-utils/learnerWrite';
import {
  CourseManifest,
  CourseStep,
  fetchStepHtml,
  findStep,
  stepIndex,
} from '../../../utils/custom-utils/courseContent';
import { Outcome } from '../../../utils/custom-utils/grader';
import { gradeStep } from '../../../utils/custom-utils/opLogGrade';

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
}

const OnlineCourse: React.FC<OnlineCourseProps> = ({
  manifest,
  stepId,
  loadNote = '',
  onSelectStep,
}) => {
  const [html, setHtml] = useState<string>('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [showHint, setShowHint] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // live-modify demo state
  const [demoStatus, setDemoStatus] = useState('');
  const [demoRunning, setDemoRunning] = useState(false);

  const step: CourseStep | undefined = manifest ? findStep(manifest, stepId) : undefined;
  const mode = step?.type ?? 'course';
  const isLiveDemo = step?.demo === 'live-modify';
  const isLoadExample = step?.demo === 'load-example';

  // On step change: fetch its HTML, reset UI. Progress persistence and window
  // resizing both live in App — the source of truth for the active step.
  useEffect(() => {
    if (!manifest || !step || !stepId) return;
    setOutcome({ kind: 'idle' });
    setShowHint(false);
    setDemoStatus('');

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

  const goNext = () => nextStep && onSelectStep(nextStep.id);
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

  // Course page (full height). Content HTML comes from Hugo (trusted source).
  if (mode === 'course') {
    const nextLabel = nextStep?.type === 'exercise' ? "Let's practice →" : 'Continue →';
    return (
      <div style={S.coursePage}>
        <div style={S.courseInner}>
          {loadNote && <div style={S.loadNote}>{loadNote}</div>}
          <div dangerouslySetInnerHTML={{ __html: html }} />
          {/* No forward button on the last / only page of a course. */}
          {nextStep && (
            <button style={S.primaryBtn} onClick={goNext}>
              {nextLabel}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Live-modify demo exercise (compact banner): a scripted plugin action instead
  // of the Verify flow.
  if (isLiveDemo) {
    return (
      <div style={S.banner}>
        <div style={S.bannerMain}>
          <div style={S.instruction} dangerouslySetInnerHTML={{ __html: html }} />
          {demoStatus && <div style={S.demoStatus}>{demoStatus}</div>}
        </div>

        <div style={S.bottomRow}>
          <div style={S.feedbackWrap} />
          <div style={S.bannerActions}>
            <button style={S.ghostBtn} onClick={goPrev} disabled={!prevStep}>
              ← Back
            </button>
            <button
              style={{ ...S.actionPrimaryBtn, ...(demoRunning ? S.btnDisabled : null) }}
              onClick={runLiveDemo}
              disabled={demoRunning}>
              {demoRunning ? 'Running…' : '▶ Run live edits'}
            </button>
            <button style={S.ghostBtn} onClick={goNext} disabled={!nextStep}>
              {nextStep ? 'Next →' : 'Finish'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Load-example demo exercise (compact banner): inject the canonical rows so the
  // learner is never blocked when the AI extraction misfires.
  if (isLoadExample) {
    return (
      <div style={S.banner}>
        <div style={S.bannerMain}>
          <div style={S.instruction} dangerouslySetInnerHTML={{ __html: html }} />
          {demoStatus && <div style={S.demoStatus}>{demoStatus}</div>}
        </div>

        <div style={S.bottomRow}>
          <div style={S.feedbackWrap} />
          <div style={S.bannerActions}>
            <button style={S.ghostBtn} onClick={goPrev} disabled={!prevStep}>
              ← Back
            </button>
            <button
              style={{ ...S.actionPrimaryBtn, ...(demoRunning ? S.btnDisabled : null) }}
              onClick={runLoadExample}
              disabled={demoRunning}>
              {demoRunning ? 'Loading…' : '⬇ Load the example'}
            </button>
            <button style={S.ghostBtn} onClick={goNext} disabled={!nextStep}>
              {nextStep ? 'Next →' : 'Finish'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Exercise page (compact banner). Instruction HTML comes from Hugo.
  return (
    <div style={S.banner}>
      <div style={S.bannerMain}>
        <div style={S.instruction} dangerouslySetInnerHTML={{ __html: html }} />
        {showHint && step.hint && <div style={S.hint}>{step.hint}</div>}
      </div>

      <div style={S.bottomRow}>
        <div style={S.feedbackWrap}>
          {outcome.kind !== 'idle' && (
            <span style={feedbackStyle(outcome.kind)}>{feedbackText(outcome)}</span>
          )}
        </div>

        <div style={S.bannerActions}>
          <button style={S.ghostBtn} onClick={goPrev} disabled={!prevStep}>
            ← Back
          </button>
          {step.hint && (
            <button style={S.ghostBtn} onClick={() => setShowHint((v) => !v)}>
              {showHint ? 'Hide help' : 'Help'}
            </button>
          )}
          <button
            style={{ ...S.actionPrimaryBtn, ...(verifying ? S.btnDisabled : null) }}
            onClick={passed ? goNext : onVerify}
            disabled={(passed && !nextStep) || verifying}>
            {passed ? (nextStep ? 'Next →' : 'Finish') : verifying ? 'Checking…' : 'Verify'}
          </button>
        </div>
      </div>
    </div>
  );
};

function feedbackText(o: Outcome): string {
  switch (o.kind) {
    case 'pass':
      return '✅ Well done — the shared master is back in sync.';
    case 'fail':
      return `❌ Not yet — ${o.reason}.`;
    case 'missing':
      return `⚠️ Couldn't find ${o.what} in the base. Check that the base matches the exercise.`;
    default:
      return '';
  }
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
  primaryBtn: {
    marginTop: 8,
    padding: '10px 18px',
    fontSize: 15,
    fontWeight: 600,
    color: '#fff',
    background: '#ff8000',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
  },
  btnDisabled: { opacity: 0.6, cursor: 'default' },
  demoStatus: { marginTop: 8, fontSize: 13, color: '#333' },
  banner: {
    height: '100%',
    boxSizing: 'border-box',
    overflowY: 'auto',
    background: '#fff',
    padding: '12px 18px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    alignItems: 'stretch',
    gap: 8,
  },
  bannerMain: { minWidth: 0 },
  bottomRow: { display: 'flex', alignItems: 'center', gap: 12 },
  feedbackWrap: { flex: 1, minWidth: 0 },
  instruction: { fontSize: 15, lineHeight: 1.5, color: '#222' },
  hint: {
    marginTop: 8,
    padding: '8px 12px',
    borderRadius: 6,
    fontSize: 14,
    background: '#eef4ff',
    color: '#1c4e80',
  },
  bannerActions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  ghostBtn: {
    padding: '8px 14px',
    fontSize: 14,
    fontWeight: 600,
    color: '#444',
    background: '#fff',
    border: '1px solid #d0d0d0',
    borderRadius: 6,
    cursor: 'pointer',
  },
  actionPrimaryBtn: {
    padding: '8px 16px',
    fontSize: 14,
    fontWeight: 600,
    color: '#fff',
    background: '#ff8000',
    border: '1px solid transparent',
    borderRadius: 6,
    cursor: 'pointer',
  },
};

export default OnlineCourse;
