import React, { useEffect, useState } from 'react';
import {
  authoredUpdateRow,
  deleteColleagueToken,
  findRowId,
  learnerUpdateRow,
} from '../../../utils/custom-utils/authoredWrite';
import {
  CourseManifest,
  CourseStep,
  fetchManifest,
  fetchStepHtml,
  findStep,
  stepIndex,
} from '../../../utils/custom-utils/courseContent';
import { grade, Outcome } from '../../../utils/custom-utils/grader';
import { getCurrentStepId, setCurrentStepId } from '../../../utils/custom-utils/courseProgress';
import { findRowByMatch, getTableByName } from '../../../utils/custom-utils/sdkRead';

/**
 * Online courses plugin — manifest-driven runner (Course 3 — Collaboration + others).
 *
 * Content/grading are NOT hardcoded here: the plugin fetches a per-course manifest
 * (ordered steps + answer keys) from the Hugo course site (courseContent.ts),
 * renders each step's HTML, grades exercises declaratively (grader.ts), and stores
 * only the current step per course (courseProgress.ts) so learners resume where
 * they left off. One plugin serves all seven courses.
 *
 * Step types drive the layout: 'course' = full-height lesson page; 'exercise' =
 * compact bottom banner. The plugin window is height-resized to match.
 */

// --- course / deep-link resolution ------------------------------------------

// While the Hugo host doesn't exist yet, skip the remote manifest fetch entirely
// (it would throw CORS/NetworkError noise in the console) and use the bundled
// fallback. Flip to true once CONTENT_BASE points at a real, CORS-enabled host.
const USE_REMOTE_CONTENT = false;

const COURSE_PARAM = 'cid';
const DEFAULT_COURSE_ID = 'course-3';
// Deep-link a single step via `qid` (4 alphanumeric chars, like SeaTable's tid/vid).
const QID_PARAM = 'qid';
const QID_PATTERN = /^[a-zA-Z0-9]{4}$/;

// TODO: ultimately the courseId should come from the imported base itself (each
// course ships its own base). For now: `cid` URL param → default.
function resolveCourseId(): string {
  try {
    const raw = new URLSearchParams(window.location.search).get(COURSE_PARAM);
    return raw && /^[a-z0-9-]+$/i.test(raw) ? raw : DEFAULT_COURSE_ID;
  } catch {
    return DEFAULT_COURSE_ID;
  }
}

function getQidFromUrl(): string | null {
  try {
    const raw = new URLSearchParams(window.location.search).get(QID_PARAM);
    return raw && QID_PATTERN.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

// Initial step: a valid `qid` deep-link wins; else resume saved progress; else
// the first step.
function resolveInitialStepId(manifest: CourseManifest, courseId: string): string {
  const qid = getQidFromUrl();
  if (qid && findStep(manifest, qid)) return qid;
  const saved = getCurrentStepId(courseId);
  if (saved && findStep(manifest, saved)) return saved;
  return manifest.steps[0].id;
}

// --- offline fallback (keeps the plugin demonstrable before/without Hugo) -----
// Reproduces the original Course-3 demo. The grade rule is row_id-based (matching
// the gateway Update-Row shape), so we resolve the demo row's _id from the live
// base — letting the row_id grader work against the current test base with no host.

const LESSON_HTML = `
  <h1>Collaboration</h1>
  <p class="lead">Work together on shared data — share it, keep it in sync, and build the
  habits that keep everyone on the same page.</p>
  <p>Your company has three customer-facing teams — <b>Commercial</b>, <b>Marketing</b> and
  <b>Support</b>. Each kept its own copy of the customer list, and the copies drifted out of
  sync: wrong contacts, duplicates, stale statuses. You're on Commercial, and you own the
  <b>customer master</b>. Your job: make it the single source of truth for the whole company.</p>
  <p>Let's start with something concrete — a teammate has flagged a record that's out of date.</p>`;

const EXERCISE_HTML = `
  <b>Marketing</b> flagged that <b>James Bennett</b>'s account status is out of date.
  Update <b>James Bennett</b>'s <b>Status</b> to <b>"Client"</b> to keep everyone in sync.`;

function buildFallbackManifest(courseId: string): CourseManifest {
  const table = getTableByName('Customers');
  const row = table ? findRowByMatch(table, 'Full Name', 'James Bennett') : null;
  const bennettId = row?._id ?? '__SET_DEMO_ROW_ID__';
  return {
    courseId,
    title: 'Collaboration (offline fallback)',
    steps: [
      { id: 'le01', type: 'course', title: 'Collaboration', html: LESSON_HTML },
      {
        id: 'ex01',
        type: 'exercise',
        title: 'Fix the stale status',
        html: EXERCISE_HTML,
        hint: 'Open the Customers table, find the James Bennett row, and set its Status cell to Client.',
        grade: {
          table_name: 'Customers',
          expected: [{ row_id: bennettId, row: { Status: 'Client' } }],
        },
      },
    ],
  };
}

// --- dev benches (authorship testing) — gated, kept from the v0 demonstrator ---

const SHOW_DEV_BENCH = true; // flip off to hide the authorship test benches

// A scripted sequence of real learner writes (via the dtable-store op, see writeCell),
// spaced out, so we can watch cells change and inspect how SeaTable attributes the
// edits in row history — and confirm the op matches a manual edit (singular
// modify_row with a populated old_row, so it's restorable).
const LIVE_DEMO: { matchValue: string; column: string; value: string; delayMs: number }[] = [
  { matchValue: 'James Bennett', column: 'Status', value: 'Lead', delayMs: 0 },
  { matchValue: 'James Bennett', column: 'Status', value: 'Prospect', delayMs: 900 },
  { matchValue: 'James Bennett', column: 'Status', value: 'Client', delayMs: 900 },
];

// Authored-write test: edit a row AS this named colleague (via a session-created
// API token), so Last-modifier shows the colleague rather than the learner.
const COLLEAGUE = {
  appName: 'Marie (Marketing)',
  tableName: 'Customers',
  // Target the row directly by _id (deterministic for testing). Leave '' to fall
  // back to matching by matchColumnName/matchValue — required after re-importing the
  // regenerated base, which assigns fresh row ids.
  rowId: '',
  matchColumnName: 'Full Name',
  matchValue: 'James Bennett',
  column: 'Status',
  // Distinct from the LIVE_DEMO end value (Client) so the authored edit is a real
  // change on top of the learner's edit — the mixed-edit history smoke-test.
  value: 'Churned',
};

// Write a single cell authored as the learner via learnerUpdateRow, which drives
// dtable-store directly so the op is identical to a manual UI edit (singular
// modify_row + populated old_row) — NOT dtableSDK.modifyRow (old_row:null, crashes
// history) and NOT the REST gateway (plural modify_rows, empty old_rows, non-
// restorable). `setValue` is a display value (column NAME → label). Resolves the
// row by a match column/value, then writes by row _id.
async function writeCell(
  tableName: string,
  matchColumnName: string,
  matchValue: string,
  setColumnName: string,
  setValue: string
): Promise<{ ok: true } | { ok: false; what: string }> {
  const table = getTableByName(tableName);
  if (!table) return { ok: false, what: `table "${tableName}"` };
  const row = findRowByMatch(table, matchColumnName, matchValue);
  if (!row) return { ok: false, what: `row "${matchValue}"` };
  await learnerUpdateRow(tableName, row._id, { [setColumnName]: setValue });
  return { ok: true };
}

// --- window resize ----------------------------------------------------------

// Resize the plugin window to a fraction of the viewport height (with a px floor),
// mirroring ResizableWrapper: set the modal height and anchor the host to the bottom.
function setPluginHeight(ratio: number, minPx: number) {
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

// ----------------------------------------------------------------------------

const OnlineCourse: React.FC<{ allTables: any[] }> = () => {
  const [courseId] = useState<string>(() => resolveCourseId());
  const [manifest, setManifest] = useState<CourseManifest | null>(null);
  const [loadNote, setLoadNote] = useState<string>(''); // non-fatal: explains fallback
  const [stepId, setStepId] = useState<string | null>(null);
  const [html, setHtml] = useState<string>('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const [showHint, setShowHint] = useState(false);

  // dev-bench state
  const [demoStatus, setDemoStatus] = useState('');
  const [demoRunning, setDemoRunning] = useState(false);
  const [colleagueStatus, setColleagueStatus] = useState('');
  const [colleagueRunning, setColleagueRunning] = useState(false);

  // Load the course manifest (Hugo), fall back to the bundled demo on failure.
  useEffect(() => {
    let cancelled = false;
    setPluginHeight(0.95, 320); // give the loading view (with dev benches) room
    (async () => {
      let m: CourseManifest;
      if (USE_REMOTE_CONTENT) {
        try {
          m = await fetchManifest(courseId);
        } catch (err: any) {
          m = buildFallbackManifest(courseId);
          if (!cancelled)
            setLoadNote(`Using offline fallback (${err?.message || 'manifest unavailable'}).`);
        }
      } else {
        m = buildFallbackManifest(courseId);
      }
      if (cancelled) return;
      setManifest(m);
      setStepId(resolveInitialStepId(m, courseId));
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const step: CourseStep | undefined = manifest ? findStep(manifest, stepId) : undefined;
  const mode = step?.type ?? 'course';

  // On step change: fetch its HTML, resize the window, persist progress, reset UI.
  useEffect(() => {
    if (!manifest || !step || !stepId) return;
    setOutcome({ kind: 'idle' });
    setShowHint(false);
    setCurrentStepId(courseId, stepId);
    if (mode === 'course') setPluginHeight(0.95, 320);
    else setPluginHeight(0.22, 130);

    let cancelled = false;
    setHtml('');
    fetchStepHtml(courseId, step)
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

  const goNext = () => nextStep && setStepId(nextStep.id);
  const goPrev = () => prevStep && setStepId(prevStep.id);
  const onVerify = () => step?.grade && setOutcome(grade(step.grade));
  const passed = outcome.kind === 'pass';

  // --- dev benches ----------------------------------------------------------
  const runLiveDemo = async () => {
    if (demoRunning) return;
    setDemoRunning(true);
    setDemoStatus('Running…');
    try {
      for (const s of LIVE_DEMO) {
        if (s.delayMs) await new Promise((res) => setTimeout(res, s.delayMs));
        const r = await writeCell(
          COLLEAGUE.tableName,
          COLLEAGUE.matchColumnName,
          s.matchValue,
          s.column,
          s.value
        );
        if (!r.ok) {
          setDemoStatus(`⚠️ Couldn't find ${r.what} — check the demo base.`);
          setDemoRunning(false);
          return;
        }
        setDemoStatus(`✏️ ${s.matchValue} · ${s.column} → ${s.value}`);
      }
      setDemoStatus(`✅ Done. Open ${LIVE_DEMO[0].matchValue}'s row history to see attribution.`);
    } catch (err: any) {
      setDemoStatus(`❌ ${err?.message || 'Live edit failed.'}`);
    }
    setDemoRunning(false);
  };

  const runColleagueEdit = async () => {
    if (colleagueRunning) return;
    setColleagueRunning(true);
    setColleagueStatus('Running…');
    try {
      const rowId =
        COLLEAGUE.rowId ||
        findRowId(COLLEAGUE.tableName, COLLEAGUE.matchColumnName, COLLEAGUE.matchValue);
      if (!rowId) {
        setColleagueStatus(`⚠️ Couldn't find row "${COLLEAGUE.matchValue}".`);
        setColleagueRunning(false);
        return;
      }
      await authoredUpdateRow(COLLEAGUE.appName, COLLEAGUE.tableName, rowId, {
        [COLLEAGUE.column]: COLLEAGUE.value,
      });
      setColleagueStatus(
        `✅ Edited as "${COLLEAGUE.appName}". Last modifier should show this name.`
      );
    } catch (err: any) {
      setColleagueStatus(`❌ ${err?.message || 'Authored write failed.'}`);
    }
    setColleagueRunning(false);
  };

  const runDeleteToken = async () => {
    setColleagueStatus('Deleting token…');
    try {
      await deleteColleagueToken(COLLEAGUE.appName);
      setColleagueStatus(`🧹 Deleted token "${COLLEAGUE.appName}".`);
    } catch (err: any) {
      setColleagueStatus(`❌ ${err?.message || 'Delete failed.'}`);
    }
  };

  // --- render ---------------------------------------------------------------
  // Authorship test benches — independent of the course manifest / network, so
  // they're usable even while (or if) the manifest fetch is pending or failing.
  const devBench = SHOW_DEV_BENCH ? (
    <>
      <div style={S.demoBox}>
        <div style={S.demoTitle}>Live-modify test</div>
        <p style={S.demoDesc}>
          Edit <b>{LIVE_DEMO[0]?.matchValue}</b>'s <b>{LIVE_DEMO[0]?.column}</b> a few times; watch
          the grid, then open the row history to see attribution.
        </p>
        <button
          style={{ ...S.secondaryBtn, ...(demoRunning ? S.btnDisabled : null) }}
          onClick={runLiveDemo}
          disabled={demoRunning}>
          {demoRunning ? 'Running…' : '▶ Run live edits'}
        </button>
        {demoStatus && <div style={S.demoStatus}>{demoStatus}</div>}
      </div>

      <div style={S.demoBox}>
        <div style={S.demoTitle}>Authored-write test (colleague)</div>
        <p style={S.demoDesc}>
          Edit <b>{COLLEAGUE.matchValue}</b>'s <b>{COLLEAGUE.column}</b> → <b>{COLLEAGUE.value}</b>{' '}
          authored as <b>{COLLEAGUE.appName}</b>.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            style={{ ...S.secondaryBtn, ...(colleagueRunning ? S.btnDisabled : null) }}
            onClick={runColleagueEdit}
            disabled={colleagueRunning}>
            {colleagueRunning ? 'Running…' : `▶ Edit as ${COLLEAGUE.appName}`}
          </button>
          <button
            style={{ ...S.secondaryBtn, ...(colleagueRunning ? S.btnDisabled : null) }}
            onClick={runDeleteToken}
            disabled={colleagueRunning}>
            🧹 Delete token
          </button>
        </div>
        {colleagueStatus && <div style={S.demoStatus}>{colleagueStatus}</div>}
      </div>
    </>
  ) : null;

  if (!manifest || !step) {
    return (
      <div style={S.coursePage}>
        <div style={S.courseInner}>
          <div style={{ marginBottom: 16 }}>Loading…</div>
          {devBench}
        </div>
      </div>
    );
  }

  // Course page (full height). Content HTML comes from Hugo (trusted source).
  if (mode === 'course') {
    const nextLabel = !nextStep
      ? 'Finish'
      : nextStep.type === 'exercise'
        ? "Let's practice →"
        : 'Continue →';
    return (
      <div style={S.coursePage}>
        <div style={S.courseInner}>
          {loadNote && <div style={S.loadNote}>{loadNote}</div>}
          <div dangerouslySetInnerHTML={{ __html: html }} />
          <button style={S.primaryBtn} onClick={goNext} disabled={!nextStep}>
            {nextLabel}
          </button>

          {devBench}
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
            style={S.actionPrimaryBtn}
            onClick={passed ? goNext : onVerify}
            disabled={passed && !nextStep}>
            {passed ? (nextStep ? 'Next →' : 'Finish') : 'Verify'}
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
  secondaryBtn: {
    padding: '8px 16px',
    fontSize: 14,
    fontWeight: 600,
    color: '#444',
    background: '#fff',
    border: '1px solid #d0d0d0',
    borderRadius: 6,
    cursor: 'pointer',
  },
  btnDisabled: { opacity: 0.6, cursor: 'default' },
  demoBox: {
    marginTop: 28,
    padding: '14px 16px',
    border: '1px dashed #d0d0d0',
    borderRadius: 8,
    background: '#fafafa',
  },
  demoTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    margin: '0 0 6px',
  },
  demoDesc: { fontSize: 14, lineHeight: 1.5, color: '#444', margin: '0 0 10px' },
  demoStatus: { marginTop: 10, fontSize: 13, color: '#333' },
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
