import React, { useEffect, useRef, useState } from 'react';
import {
  CourseManifest,
  CourseStep,
  fetchStepHtml,
  findStep,
  stepIndex,
  courseWebsiteLink,
} from '../../../utils/custom-utils/courseContent';
import { AutomationRuleRule, Outcome } from '../../../utils/custom-utils/grader';
import { gradeStep } from '../../../utils/custom-utils/opLogGrade';
import { seedDiscrepancy } from '../../../utils/custom-utils/seedDiscrepancy';
import {
  getCourseFlag,
  setCourseFlag,
  stepDoneKey,
  stepPassedKey,
} from '../../../utils/custom-utils/courseStore';
import {
  countDeliveryLines,
  deliveryDocumentAvailable,
  reloadDeliveryLines,
  rewindDelivery,
} from '../../../utils/custom-utils/rewindDelivery';
import { webhookBurst } from '../../../utils/custom-utils/webhookBurst';
import { colleagueStoreWrite } from '../../../utils/custom-utils/colleagueStoreWrite';
import { colleagueReply } from '../../../utils/custom-utils/colleagueComment';
import ColleagueSetup from './ColleagueSetup';
import ColleagueWindow from './ColleagueWindow';
import {
  gradeAutomationRule,
  listAutomationRuleIds,
} from '../../../utils/custom-utils/automationGrade';
import {
  appendRowsTracked,
  awaitLinks,
  getActiveTableName,
  getActiveViewName,
  missingLinkTargets,
  tableHasView,
} from '../../../utils/custom-utils/watchAutomation';
import { FloatControls } from '../../../utils/custom-interfaces/FloatControls';
import { t } from '../../../locale/t';
import { missingBaseParts } from '../../../utils/custom-utils/baseCheck';

/**
 * Online courses plugin — manifest-driven runner (Course 3 — Collaboration + others).
 *
 * The runner is CONTROLLED: the course manifest and the current step are owned by
 * App (so the left-panel navigation tree and the runner stay in sync) and passed in
 * as props. This component fetches each step's HTML, renders it, grades exercises
 * (grader.ts) and resizes the plugin window. Navigation is delegated up to
 * `onSelectStep`, which also persists progress (courseStore.ts).
 *
 * Step types drive the layout: 'course' = full-height lesson page; 'exercise' =
 * compact bottom banner. The plugin window is height-resized to match. An exercise
 * carrying a `demo` swaps the Verify flow for a scripted plugin action.
 */

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
  // Ask App to shrink the plugin to the floating toolbar. Used when the learner
  // picks the guided automation build: the first stage tells them to create a new
  // rule, and that button sits in the base BEHIND the expanded panel.
  onRequestFloat?: () => void;
  // Reports the exercise banner's natural content height (px) so App can size the
  // plugin window to show the whole instruction/hint/result without scrolling. Must
  // be stable. Not called on full-height lesson pages.
  onContentHeight?: (px: number) => void;
}

// A full-height page can still have something to verify or a plugin action to run
// (Welcome 6, Course 4 step 2): it then behaves like an exercise, at full height.
function interactivePageFor(step: CourseStep): boolean {
  return (
    !!step.grade ||
    (!!step.demo && step.demo !== 'colleague-window' && step.demo !== 'colleague-setup')
  );
}

// The page's "Your turn:" block: the one sentence saying what to do now. It is the
// SAME text the floating toolbar shows — the step's (or stage's, or the watch demo's)
// `instruction` — so the page body never repeats it. A border and an indent, no
// tinted box: next to the table/view note it would make one colour too many.
const InstructionBlock: React.FC<{ html?: string }> = ({ html }) =>
  html ? (
    <div style={S.todo}>
      <span style={S.todoLabel}>{t('course.your_turn')}</span>{' '}
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  ) : null;

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

function forwardFor(step: CourseStep, nextStep?: CourseStep): Forward {
  if (step.continuesOn === 'plugin' && nextStep) return { kind: 'next', step: nextStep };
  if (step.continuesOn === 'website')
    return { kind: 'website', note: step.handoffNote ?? t('course.handoff_default') };
  // Unset (plugin front-matter like the Introduction): plain structural nav.
  return nextStep ? { kind: 'next', step: nextStep } : { kind: 'end' };
}

// Datastore key for "this learner has already rewound the Step-4 delivery".
const REWOUND_FLAG = 'step4-rewound';
// A demo step that creates something in the base must not create it twice: coming
// back to it (with Back, or from the menu) has to show "already done" rather than
// replay the action. Per-step so each checkpoint remembers its own — and the same
// flag is what the step list shows as a checkmark.
const doneFlag = stepDoneKey;

const OnlineCourse: React.FC<OnlineCourseProps> = ({
  manifest,
  stepId,
  loadNote = '',
  onSelectStep,
  onFloatControls,
  onRequestFloat,
  onContentHeight,
}) => {
  const [html, setHtml] = useState<string>('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  // The pass shown on arrival came from an earlier visit, not from a verify run
  // just now. It keeps the page in step with the checkmark in the step list — and
  // stops the post-pass "watch it work" demo from offering to write its rows again.
  const [restoredPass, setRestoredPass] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // Shared by every scripted plugin action (seed, rewind, safety net): what it is
  // doing right now, and whether it is still doing it.
  const [demoStatus, setDemoStatus] = useState('');
  const [demoRunning, setDemoRunning] = useState(false);

  // automation-guided state: 'choice' → guided stepper or one-shot check.
  const [autoMode, setAutoMode] = useState<'choice' | 'guided' | 'check'>('choice');
  // Guided build tracking. `guidedBaseline` is the set of rule ids that existed when
  // the learner chose to be guided, so stage 1 accepts only a rule they just added;
  // `guidedRuleId` then pins every later stage to that one rule. Without this the
  // stages grade the base's STATE, and a rule left over from a previous run makes
  // all four pass without the learner doing anything.
  const guidedBaseline = useRef<string[]>([]);
  const guidedBaselineTaken = useRef(false);
  const guidedRuleId = useRef<string | null>(null);
  // 'seed-discrepancy': the document the plugin created for this run. The grade is
  // pinned to it — a brand-new row has no history, so an "automation set Reviewer"
  // entry on it cannot be left over from something the learner did earlier. State,
  // not a ref: it also decides which button the step offers.
  const [seededDocId, setSeededDocId] = useState<string | null>(null);
  // 'rewind': the delivery has been taken out of the base, so the step's action
  // becomes "verify what came back" — with the safety net alongside it. Persisted
  // per course (courseStore.ts): the learner leaves the plugin between the
  // rewind and the verify, and a forgotten flag would offer to rewind the delivery
  // they have just had the AI read back in.
  const [rewound, setRewound] = useState(false);
  // Persisted "this step's action has already run" — see doneFlag.
  const [demoDone, setDemoDone] = useState(false);
  const [autoStageIdx, setAutoStageIdx] = useState(0);

  // "Watch it work" state (a step with `watch`, entered once the exercise passes).
  // 'ready' = offer to write the rows; 'running' = writing + waiting for the
  // learner's automation to fill the links; 'linked' = it did; 'stalled' = it didn't
  // (yet) — offer another look rather than calling it a failure.
  const [watchPhase, setWatchPhase] = useState<'idle' | 'ready' | 'running' | 'linked' | 'stalled'>(
    'idle'
  );
  const [watchRowIds, setWatchRowIds] = useState<string[]>([]);
  const [watchNote, setWatchNote] = useState('');
  // The table the base is currently showing, polled while we're waiting for the
  // learner to press "Add the delivery lines", so the "open Line items" nudge can
  // clear itself the moment they switch. Advisory only: we can't navigate the host,
  // and the read is its own bookkeeping (unverified in a real base) — a bad read
  // must never trap the learner, so the button stays live either way.
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<string | null>(null);

  // The exercise banner's content, measured so App can size the plugin to fit.
  const bannerRef = useRef<HTMLDivElement | null>(null);

  const step: CourseStep | undefined = manifest ? findStep(manifest, stepId) : undefined;
  const mode = step?.type ?? 'course';
  const isAutomationGuided = step?.demo === 'automation-guided';
  const isSeedDiscrepancy = step?.demo === 'seed-discrepancy';
  const isRewind = step?.demo === 'rewind';
  const isBurst = step?.demo === 'webhook-burst';
  const isWriteLines = step?.demo === 'write-lines';
  const isColleagueWrite = step?.demo === 'colleague-write';
  const isColleagueSetup = step?.demo === 'colleague-setup';
  const isColleagueWindow = step?.demo === 'colleague-window';

  // On step change: fetch its HTML, reset UI. Progress persistence and window
  // resizing both live in App — the source of truth for the active step.
  useEffect(() => {
    if (!manifest || !step || !stepId) return;
    setOutcome({ kind: 'idle' });
    setShowHint(false);
    setDemoStatus('');
    setAutoMode('choice');
    setAutoStageIdx(0);
    guidedBaseline.current = [];
    guidedBaselineTaken.current = false;
    guidedRuleId.current = null;
    setSeededDocId(null);
    setRewound(step.demo === 'rewind' && getCourseFlag(manifest.courseId, REWOUND_FLAG));
    setDemoDone(getCourseFlag(manifest.courseId, doneFlag(step.id)));
    // A verify that passed on an earlier visit is shown as passed again, so the page
    // says what the step list's checkmark says.
    const passedBefore = !!step.grade && getCourseFlag(manifest.courseId, stepPassedKey(step.id));
    setRestoredPass(passedBefore);
    if (passedBefore) {
      setOutcome({ kind: 'pass' });
      // The guided build is over: show its checked state, not the guided/check choice.
      if (step.demo === 'automation-guided') setAutoMode('check');
    }
    // A page with nothing to do or to observe is done once it has been opened. The
    // windows on Malika are not: they wait for what they exist to show.
    if (step.type === 'course' && !step.grade && !step.demo) {
      setCourseFlag(manifest.courseId, doneFlag(step.id), true);
    }
    setWatchPhase('idle');
    setWatchRowIds([]);
    setWatchNote('');
    setActiveTable(null);
    setActiveView(null);

    let cancelled = false;
    setHtml('');
    fetchStepHtml(manifest.courseId, step)
      .then((h) => !cancelled && setHtml(h))
      .catch(() => !cancelled && setHtml(`<p>${t('course.page_load_failed')}</p>`));
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
    // A check answers the step; what the last action said ("3 lines and the document
    // removed…") is history by then, and stacked above the result it read as part of
    // it (2026-11-11 test, Course 4 step 4).
    setDemoStatus('');
    setVerifying(true);
    try {
      setOutcome(
        await gradeStep(step.grade, {
          rowIds: seededDocId ? [seededDocId] : undefined,
        })
      );
    } finally {
      setVerifying(false);
    }
  };
  const passed = outcome.kind === 'pass';

  /**
   * The lifecycle of an action step, in one place: run it, and it is DONE — the
   * button stops offering the same click and offers to start over instead, and the
   * state survives leaving the step and coming back. Starting over only clears that
   * state; it does not re-run anything, so the learner decides when to fire the
   * action again. Nothing here is ever a dead end.
   */
  const markDemoDone = () => {
    setDemoDone(true);
    if (manifest && step) setCourseFlag(manifest.courseId, doneFlag(step.id), true);
  };
  // The reverse of markDemoDone, for a page whose success can be lost again.
  const unmarkDemoDone = () => {
    setDemoDone(false);
    if (manifest && step) setCourseFlag(manifest.courseId, doneFlag(step.id), false);
  };
  const startOver = () => {
    if (demoRunning) return;
    setDemoDone(false);
    setDemoStatus('');
    setOutcome({ kind: 'idle' });
    setRestoredPass(false);
    if (manifest && step) {
      setCourseFlag(manifest.courseId, doneFlag(step.id), false);
      setCourseFlag(manifest.courseId, stepPassedKey(step.id), false);
    }
  };
  /**
   * The faces of an action step's button: fire it, or clear it and start again —
   * and, before either, refuse to fire while the learner is demonstrably looking
   * somewhere else.
   *
   * These actions exist to be WATCHED: the webhook burst adds a row, edits it and
   * deletes it again, so a learner parked on another table sees nothing at all and
   * is left with a step that claims to be done. The nudge alone was too easy to
   * click straight past, so the precondition is now enforced, not suggested.
   *
   * It leans on `tableNote`, which is set ONLY when the active table was read
   * successfully AND differs from the one the step watches. An unreadable table
   * leaves it empty and the button fires as before — never trap a learner on a bad
   * read (same rule as getActiveTableName's own contract).
   */
  const actionPrimary = (title: string, onClick: () => void): FloatControls['primary'] => {
    if (demoDone)
      return { icon: 'run', title: t('course.start_over'), onClick: startOver, busy: demoRunning };
    // Both reads now block, each measured against a real base: `tid`/`vid` are the
    // host's own selection, and the note was watched appearing on the default view
    // and clearing on the right one. Blocking is the point — an action nobody
    // watched is a step the learner has silently lost. The safety property lives in
    // the terms themselves: an unreadable selection resolves to null, `wrongTable` /
    // `wrongView` stay false, and nothing is blocked.
    if ((wrongTable || wrongView) && step?.watchTable)
      return {
        icon: 'run',
        title: wrongView
          ? t('course.open_view_first', { view: step.watchView ?? '' })
          : t('course.open_table_first', { table: step.watchTable }),
        onClick: () => undefined,
        disabled: true,
      };
    return { icon: 'run', title, onClick, busy: demoRunning };
  };
  /** What an action step says once it has run — live status, else its stored line. */
  const actionFeedback = (): FloatControls['feedback'] => {
    // Before the action, a learner on the wrong table is the thing worth saying.
    if (!demoDone && !demoStatus && tableNote) return { kind: 'info', text: tableNote };
    // Once it is done, say where the course goes next: these steps hand back to the
    // website, so there is no forward button to carry that closer.
    const closer = demoDone && forward.kind === 'website' ? ` ${forward.note}` : '';
    if (demoStatus) {
      return { kind: demoDone ? 'pass' : 'info', text: `${demoStatus}${closer}` };
    }
    if (demoDone && step?.demoDoneMessage) {
      return { kind: 'pass', text: `${step.demoDoneMessage}${closer}` };
    }
    return undefined;
  };

  // --- seed-discrepancy demo action (Step 3) ---------------------------------
  const runSeedDiscrepancy = async () => {
    if (demoRunning || !step?.seed) return;
    setDemoRunning(true);
    // Back to "not done" for the duration: this may be a second run, and the ✅ of
    // the first would otherwise sit over the progress messages of this one.
    setDemoDone(false);
    setDemoStatus(t('course.preparing'));
    try {
      // Clear first when the step says what to clear, so running this twice replaces
      // the delivery instead of stacking a second one on the same reference — and so
      // a learner can start the exercise over.
      if (step.reset) await rewindDelivery(step.reset, setDemoStatus);
      const res = await seedDiscrepancy(step.seed, setDemoStatus);
      setSeededDocId(res.documentRowId);
      markDemoDone();
      // A document-only seed (Step 7) has no line to link, so it cannot report on
      // one: what it hands back is a header waiting for lines the learner pushes.
      setDemoStatus(
        res.linked === undefined
          ? t('course.seed.note_ready')
          : res.linked
            ? t('course.seed.short_ready')
            : t('course.seed.not_linked')
      );
    } catch (err: any) {
      setDemoStatus(t('course.error', { message: err?.message || t('course.seed.failed') }));
    }
    setDemoRunning(false);
  };

  // --- webhook-burst action (Step 5) -----------------------------------------
  const runBurst = async () => {
    if (demoRunning || !step?.burst) return;
    setDemoRunning(true);
    setDemoStatus(t('course.working'));
    try {
      const res = await webhookBurst(step.burst, setDemoStatus);
      setDemoStatus(t('course.burst.done', { count: res.operations }));
      markDemoDone();
    } catch (err: any) {
      setDemoStatus(t('course.error', { message: err?.message || t('course.burst.failed') }));
    }
    setDemoRunning(false);
  };

  // --- colleague-write action (Course 3 EXPERIMENT) --------------------------
  // Drives the edit through a SECOND store opened with the colleague's own base
  // token. What matters is not that the cell changes — REST could do that — but
  // the SHAPE of the operation it leaves in the log. See colleagueStoreWrite.ts.
  const runColleagueWrite = async () => {
    if (demoRunning || !step?.colleagueWrite) return;
    setDemoRunning(true);
    setDemoDone(false);
    setDemoStatus(t('course.working'));
    try {
      const res = await colleagueStoreWrite(step.colleagueWrite, setDemoStatus);
      if (step.colleagueReply) {
        setDemoStatus(t('course.colleague.replying'));
        await colleagueReply(step.colleagueReply);
      }
      for (const side of step.colleagueSideWrites ?? []) {
        setDemoStatus(t('course.colleague.side_writes'));
        await colleagueStoreWrite(side, () => undefined, { skipIfUnchanged: true });
      }
      markDemoDone();
      setDemoStatus(step.demoDoneMessage ?? t('course.colleague.written', { row: res.rowId }));
    } catch (err: any) {
      setDemoStatus(t('course.error', { message: err?.message || t('course.colleague.failed') }));
    }
    setDemoRunning(false);
  };

  // --- rewind action (Step 4) ------------------------------------------------
  const runRewind = async () => {
    if (demoRunning || !step?.rewind) return;
    setDemoRunning(true);
    setDemoStatus(t('course.rewinding'));
    try {
      const res = await rewindDelivery(step.rewind, setDemoStatus);
      setRewound(true);
      if (manifest) setCourseFlag(manifest.courseId, REWOUND_FLAG, true);
      setDemoStatus(
        res.document || res.lines
          ? t(
              `course.rewind.done${res.products ? '_stock' : ''}_${res.lines === 1 ? 'one' : 'other'}`,
              { count: res.lines }
            )
          : t('course.rewind.nothing')
      );
    } catch (err: any) {
      setDemoStatus(t('course.error', { message: err?.message || t('course.rewind.failed') }));
    }
    setDemoRunning(false);
  };

  // The safety net REPLACES what the extraction produced rather than adding to it,
  // so a run that wrote two lines out of three doesn't leave the base with five.
  // Resolves true when the lines are written and have a document to attach to.
  const runLoadExample = async (): Promise<boolean> => {
    if (demoRunning || !step?.example || !step?.rewind) return false;
    let attachable = false;
    setDemoRunning(true);
    setDemoStatus(t('course.writing'));
    try {
      const res = await reloadDeliveryLines(step.rewind, step.example.rows, setDemoStatus);
      const reference = step.rewind.document.reference;
      const written = t(
        `course.lines.written${res.removed ? '_replacing' : ''}_${res.added === 1 ? 'one' : 'other'}`,
        { count: res.added, removed: res.removed }
      );
      // Whether these lines can attach is the whole point of the step, so say it
      // rather than leave the learner to notice an empty Document column.
      setDemoStatus(
        res.documentFound
          ? res.documentLabelled
            ? t('course.lines.attached', { written, reference })
            : t('course.lines.done', { written })
          : t('course.lines.no_document', { written, reference })
      );
      // Only a lifecycle step owns this flag; on Step 4 the safety net rides inside a
      // graded step and must not mark it done.
      if (isWriteLines) markDemoDone();
      attachable = res.documentFound;
    } catch (err: any) {
      setDemoStatus(t('course.error', { message: err?.message || t('course.lines.failed') }));
    }
    setDemoRunning(false);
    return attachable;
  };

  // --- automation-guided actions --------------------------------------------
  const stages = step?.automationStages || [];
  // Check one guided stage (a slice of the step's automation-rule grade).
  const verifyAutomationStage = async () => {
    if (!step?.grade || verifying) return;
    const stage = stages[autoStageIdx]?.stage ?? 'all';
    setVerifying(true);
    try {
      setOutcome(
        await gradeAutomationRule(step.grade as AutomationRuleRule, stage, {
          ignoreRuleIds: guidedBaseline.current,
          pinRuleId: guidedRuleId.current,
          onRuleIdentified: (id) => {
            guidedRuleId.current = id;
          },
        })
      );
    } finally {
      setVerifying(false);
    }
  };
  const advanceStage = () => {
    setOutcome({ kind: 'idle' });
    // Close the hint: each stage has its own, and carrying an open panel across
    // would reveal the next one before the learner has tried anything.
    setShowHint(false);
    setAutoStageIdx((i) => i + 1);
  };

  // --- "watch it work" (post-pass demo) --------------------------------------
  // Step 2's automation is graded on its CONFIG, so when it passes nothing has ever
  // run through it. Before handing the learner back to the website, the plugin
  // writes real lines and shows their rule doing the linking on its own.
  const watch = step?.watch;
  // The exercise is finished (guided stepper on its last stage, or the one-shot
  // check) — the point at which the watch demo is offered.
  const exerciseComplete =
    passed && (!isAutomationGuided || autoMode === 'check' || autoStageIdx >= stages.length - 1);

  // A verify re-run that now FAILS takes the checkmark back: the base has changed
  // since it passed, and the list must not say done while the page says not yet.
  useEffect(() => {
    if (
      (outcome.kind === 'fail' || outcome.kind === 'missing') &&
      manifest &&
      step?.grade &&
      getCourseFlag(manifest.courseId, stepPassedKey(step.id))
    ) {
      setCourseFlag(manifest.courseId, stepPassedKey(step.id), false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome.kind]);

  // A passed verify is kept, so the step list can check the step off — it used to
  // live only as long as the page stayed open. Its own flag: on a step with an
  // action AND a verify, the action having run is not the step being done.
  useEffect(() => {
    if (
      exerciseComplete &&
      manifest &&
      step &&
      !getCourseFlag(manifest.courseId, stepPassedKey(step.id))
    ) {
      setCourseFlag(manifest.courseId, stepPassedKey(step.id), true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exerciseComplete]);

  // The takeover is DERIVED, not set from an effect: the moment the exercise passes,
  // this render is already the watch demo's. (An effect would let the step's own
  // "…continues on the website" closer paint first — which reads as the end of the
  // step, so the learner leaves before the demo they were meant to see.)
  const watching = !!watch && !restoredPass && (exerciseComplete || watchPhase !== 'idle');
  const wPhase = watching && watchPhase === 'idle' ? 'ready' : watchPhase;

  // Where the lines are going, and whether the learner is looking at it. Empty when
  // they're already there (or we can't tell) — the nudge only speaks up if needed.
  const watchTableNote =
    watch && wPhase === 'ready' && activeTable && activeTable !== watch.table_name
      ? t('course.watch.wrong_table', { current: activeTable, table: watch.table_name })
      : '';

  /**
   * The same nudge, for any step that declares `watchTable`: most plugin actions
   * show their result in ONE table, and a learner parked on another sees nothing
   * happen. Speaks up only when we can tell they are elsewhere, and only before the
   * action has run — afterwards there is nothing left to catch.
   */
  const wrongTable =
    !!step?.watchTable && !demoDone && !!activeTable && activeTable !== step.watchTable;
  // The view only matters once the right table is open, and only if the base
  // actually has it — see CourseStep.watchView.
  const wrongView =
    !!step?.watchTable &&
    !!step?.watchView &&
    !demoDone &&
    !wrongTable &&
    activeTable === step.watchTable &&
    tableHasView(step.watchTable, step.watchView) &&
    !!activeView &&
    activeView !== step.watchView;
  const tableNote = wrongTable
    ? t('course.wrong_table', { current: activeTable ?? '', table: step!.watchTable ?? '' })
    : wrongView
      ? t('course.wrong_view', { view: step!.watchView ?? '', table: step!.watchTable ?? '' })
      : '';

  // Poll the host's current table while a nudge could still be useful, so it clears
  // itself as soon as the learner switches tables.
  //
  // ⚠️ The dependencies must include what the FIRST branch reads. They used to be
  // [watching, wPhase] alone, so arriving at a step by navigation — which changes
  // `step` but neither of those — never restarted the poll. Changing step also resets
  // `activeTable` to null, so the value stayed null, `tableNote` stayed empty, and the
  // wrong-table nudge never appeared on any step reached this way. (Found 2026-09-01:
  // step 5a fired happily from `Documents`, saying nothing.)
  useEffect(() => {
    if (!!step?.watchTable && !demoDone) {
      const read = () => {
        setActiveTable(getActiveTableName());
        setActiveView(getActiveViewName());
      };
      read();
      const id = setInterval(read, 1200);
      return () => clearInterval(id);
    }
    if (!watching || wPhase !== 'ready') return;
    const read = () => setActiveTable(getActiveTableName());
    read();
    const id = setInterval(read, 1200);
    return () => clearInterval(id);
  }, [watching, wPhase, step?.id, step?.watchTable, step?.watchView, demoDone]);

  // Wait for the learner's automation to fill the link columns on `rowIds`, then
  // land on 'linked' or 'stalled'. Shared by the initial run and "Look again".
  const awaitWatchLinks = async (rowIds: string[]) => {
    if (!watch) return;
    const n = rowIds.length;
    const outcomeLinks = await awaitLinks(watch.table_name, rowIds, watch.link_columns, {
      onTick: (s) =>
        s.pending > 0 &&
        setWatchNote(t('course.watch.waiting', { linked: s.total - s.pending, total: s.total })),
    });
    if (outcomeLinks.kind === 'linked') {
      setWatchNote(
        t('course.watch.linked', {
          columns: watch.link_columns.join(t('course.list_and')),
          count: n,
        })
      );
      setWatchPhase('linked');
      return;
    }
    const { pending, total, missing } = outcomeLinks.progress;
    setWatchNote(
      t('course.watch.stalled', {
        linked: total - pending,
        total,
        missing: missing.join(t('course.list_and')),
      })
    );
    setWatchPhase('stalled');
  };

  const runWatch = async () => {
    if (!watch || watchPhase === 'running') return;
    // Nothing to link the rows to (a document or product removed from the base): say
    // so, and write nothing — the rule is not the problem.
    const absent = missingLinkTargets(
      watch.rows,
      step?.grade?.kind === 'automation-rule' ? (step.grade.link_actions ?? []) : []
    );
    if (absent.length) {
      setWatchNote(
        t('course.watch.missing_targets', {
          list: absent
            .map((m) => t('course.watch.missing_target', { value: m.value, table: m.table }))
            .join(', '),
          look_again: t('course.watch.look_again'),
        })
      );
      setWatchPhase('stalled');
      return;
    }
    setWatchPhase('running');
    setWatchNote(t('course.watch.writing'));
    try {
      const rowIds = await appendRowsTracked(watch.table_name, watch.rows);
      setWatchRowIds(rowIds);
      if (!rowIds.length) throw new Error(t('course.watch.not_found'));
      setWatchNote(t('course.watch.added', { count: rowIds.length }));
      await awaitWatchLinks(rowIds);
    } catch (err: any) {
      setWatchNote(t('course.error', { message: err?.message || t('course.watch.failed') }));
      setWatchPhase('stalled');
    }
  };

  const recheckWatch = async () => {
    if (!watch || watchPhase === 'running') return;
    // Nothing was written (the append itself failed) — start over rather than poll
    // rows that don't exist.
    if (!watchRowIds.length) return runWatch();
    setWatchPhase('running');
    await awaitWatchLinks(watchRowIds);
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
    if (step) fc.title = step.title;
    // Inside the guided build, prefer the CURRENT stage's hint: the step's own hint
    // describes the finished automation, which would give away the stages the
    // learner has not reached yet. Falls back to the step hint when a stage has none.
    const stageHint =
      isAutomationGuided && autoMode === 'guided' ? stages[autoStageIdx]?.hint : undefined;
    const hint = stageHint ?? step?.hint;
    // The hint is about doing the exercise — once the watch demo has taken over,
    // it's already done.
    if (hint && !watching) {
      fc.help = { shown: showHint, toggle: () => setShowHint((v) => !v), text: hint };
    }
    return fc;
  };
  const baseFloatControls = (): FloatControls => {
    if (!step) return { instruction: '' };
    const onBack = prevStep ? goPrev : undefined;
    // A page with nothing to do has no instruction: the toolbar then says to expand
    // the course — never its body flattened to one line (lists and icons lost,
    // 2026-11-10 test). The step title is added for every page in buildFloatControls.
    const text = step.instruction ?? '';
    // Forward after a pass: an in-plugin Next, else (website handoff) no button —
    // the closer surfaces in `feedback` instead.
    const forwardPrimary: FloatControls['primary'] | undefined =
      forward.kind === 'next'
        ? { icon: 'next', title: t('course.next'), onClick: () => onSelectStep(forward.step.id) }
        : undefined;
    const passFeedback = (msg?: string): FloatControls['feedback'] =>
      outcome.kind !== 'idle'
        ? { kind: outcome.kind, text: feedbackText(outcome, msg) }
        : undefined;

    // Lesson page: only a forward. A window on Malika moves on in-plugin only once
    // it has shown what it is there for.
    if (step.type === 'course' && !isColleagueSetup && !interactivePageFor(step))
      return {
        instruction: text,
        onBack,
        primary: isColleagueWindow && !demoDone ? undefined : forwardPrimary,
      };

    // "Watch it work": the exercise has passed and this step proves the rule on real
    // rows before the handoff, so the primary drives the demo, not the forward.
    if (watching) {
      // In 'ready' the instruction is the nudge itself when they're on the wrong
      // table — that's the one thing to do before pressing.
      const watchText = (wPhase === 'ready' && watchTableNote) || watch!.instruction || text;
      let primary: FloatControls['primary'] | undefined;
      // Like the other actions (actionPrimary), refuse to fire while the learner is
      // demonstrably on another table: the lines would arrive out of sight, and the
      // check would then report "0/3 linked" on rows nobody watched (2026-11-11 test).
      // An unreadable table leaves `watchTableNote` empty, so nothing is blocked.
      if (wPhase === 'ready' && watchTableNote)
        primary = {
          icon: 'run',
          title: t('course.open_table_first', { table: watch!.table_name }),
          onClick: () => undefined,
          disabled: true,
        };
      else if (wPhase === 'ready')
        primary = { icon: 'run', title: t('course.watch.add_lines'), onClick: runWatch };
      else if (wPhase === 'running')
        primary = { icon: 'run', title: t('course.working'), onClick: () => {}, busy: true };
      else if (wPhase === 'stalled')
        primary = { icon: 'check', title: t('course.watch.look_again'), onClick: recheckWatch };
      else primary = forwardPrimary; // linked → back to the normal forward
      let feedback: FloatControls['feedback'];
      if (wPhase === 'linked') {
        const closer = forward.kind === 'website' ? ` ${forward.note}` : '';
        feedback = { kind: 'pass', text: `✅ ${watch!.successMessage ?? ''}${closer}`.trim() };
      } else if (wPhase === 'ready' && passed) {
        // The grade passed but the step isn't over — acknowledge it WITHOUT the
        // website handoff, which would send the learner away mid-demo.
        feedback = { kind: 'pass', text: feedbackText(outcome, step.successMessage) };
      } else if (watchNote) {
        feedback = { kind: wPhase === 'stalled' ? 'missing' : 'info', text: watchNote };
      }
      return { instruction: watchText, onBack, primary, feedback };
    }

    // Setup step: the field carries its own Check button, so the toolbar has nothing
    // to run — it only moves the learner on once a token has been accepted.
    if (isColleagueSetup) {
      return {
        instruction: text,
        onBack,
        primary: demoDone ? forwardPrimary : undefined,
        feedback: demoDone
          ? { kind: 'pass', text: step.demoDoneMessage ?? t('course.colleague.configured') }
          : undefined,
      };
    }

    // Window-on-her step: nothing to run and nothing to grade. The panel reads her
    // side live, and the learner's own action happens in the base — so the toolbar
    // keeps the ordinary forward rather than inventing a button for a drawing.
    if (isColleagueWindow) {
      return { instruction: text, onBack, primary: forwardPrimary };
    }

    // Demo steps: the primary RUNS the scripted action; its status shows as info.
    if (isSeedDiscrepancy) {
      const runPrimary: FloatControls['primary'] = {
        icon: 'run',
        title: step.demoLabel ?? t('course.seed.prepare'),
        onClick: runSeedDiscrepancy,
        busy: demoRunning,
      };
      // Ungraded variant (Step 7a): the action IS the exercise, and what has to
      // happen next happens on the website. Nothing to verify here — the check
      // belongs to the step that follows, once the learner has pushed a line.
      if (!step.grade) {
        return {
          instruction: text,
          onBack,
          primary: actionPrimary(step.demoLabel ?? t('course.seed.prepare'), runSeedDiscrepancy),
          feedback: actionFeedback(),
        };
      }
      return {
        instruction: text,
        onBack,
        primary: passed
          ? forwardPrimary
          : seededDocId
            ? { icon: 'check', title: t('course.verify'), onClick: onVerify, busy: verifying }
            : runPrimary,
        feedback: passed
          ? passFeedback(step.successMessage)
          : demoStatus
            ? { kind: 'info', text: demoStatus }
            : tableNote
              ? { kind: 'info', text: tableNote }
              : undefined,
      };
    }

    // Write-the-lines step (Step 5b): one action, nothing graded — the lines are a
    // convenience, and what matters next (pressing Notify the dock) is done in the
    // base, not here.
    if (isWriteLines) {
      return {
        instruction: text,
        onBack,
        primary: actionPrimary(step.demoLabel ?? t('course.lines.write'), runLoadExample),
        feedback: actionFeedback(),
      };
    }

    // Colleague-write experiment (Course 3): one action, nothing graded — the
    // result is read in the base log, not here.
    if (isColleagueWrite) {
      return {
        instruction: text,
        onBack,
        primary: actionPrimary(step.demoLabel ?? t('course.colleague.edit'), runColleagueWrite),
        feedback: actionFeedback(),
      };
    }

    // Webhook step (Step 5): staging only. There is no grade — the lesson is to go
    // and read the other side — so the primary runs the change and then stands down
    // to the ordinary forward.
    if (isBurst) {
      // One action only. Writing the second delivery's lines used to hang off this
      // button's menu; it is its own menu entry now (Step 5b) — the course asks for
      // it at a different moment, and the dropdown is for choices, not for a later
      // beat of the same story.
      return {
        instruction: text,
        onBack,
        primary: actionPrimary(t('course.burst.run'), runBurst),
        feedback: actionFeedback(),
      };
    }

    // Rewind step (Step 4): take the delivery out, then verify what the AI put
    // back. The safety net rides along in the primary's menu — the extraction may
    // misfire at any point, and the learner shouldn't have to go looking for it.
    if (isRewind) {
      // The menu offers what makes sense in the base AS IT IS NOW, not after the last
      // click (2026-11-11 test: three options at every turn, and "write the lines"
      // right after the rewind wrote them with no document to attach to).
      const lineCount = countDeliveryLines(step.rewind!);
      const documentThere = deliveryDocumentAvailable(step.rewind!);
      const menu: { label: string; onClick: () => void }[] = [];
      // The safety net covers the extraction, not the form: it needs the document the
      // learner sent. Writing the lines checks the step at once — they are right.
      if (documentThere)
        menu.push({
          label: lineCount ? t('course.lines.fix') : t('course.lines.write'),
          onClick: async () => {
            if (await runLoadExample()) await onVerify();
          },
        });
      // Taking the delivery out again only means something when some of it is back.
      if (documentThere || lineCount)
        menu.push({ label: t('course.rewind.run'), onClick: runRewind });
      let primary: FloatControls['primary'] | undefined;
      // Once passed, the forward is the website (no in-plugin Next), which left the
      // step with no button at all. Start over takes the delivery out again AND
      // clears the pass, so the learner can receive it once more; the step's text
      // says so before the button is there (2026-11-10 test).
      if (passed)
        primary = forwardPrimary ?? {
          icon: 'run',
          title: t('course.start_over'),
          onClick: () => {
            startOver();
            runRewind();
          },
          busy: demoRunning,
        };
      // Before the rewind the primary just fires: the seeded lines are still there,
      // nothing has been extracted, and a dropdown in front of the one action of the
      // step would be friction offering a safety net against nothing.
      else if (!rewound)
        primary = {
          icon: 'run',
          title: t('course.rewind.run'),
          onClick: runRewind,
          busy: demoRunning,
        };
      else
        primary = {
          icon: 'check',
          title: t('course.verify'),
          onClick: onVerify,
          busy: verifying || demoRunning,
          // Nothing to offer yet (no document sent): a bare Verify, no dropdown.
          menu: menu.length
            ? [{ label: t('course.verify'), onClick: onVerify }, ...menu]
            : undefined,
        };
      return {
        instruction: text,
        onBack,
        primary,
        feedback: passed
          ? passFeedback(step.successMessage)
          : outcome.kind !== 'idle'
            ? { kind: outcome.kind, text: feedbackText(outcome, step.successMessage) }
            : demoStatus
              ? { kind: 'info', text: demoStatus }
              : tableNote
                ? { kind: 'info', text: tableNote }
                : undefined,
      };
    }

    // Automation-guided step: choice → check / guided stepper.
    if (isAutomationGuided) {
      if (autoMode === 'choice') {
        // Doing the step again: a pass restored from an earlier visit, and the watch
        // demo of an earlier run, must not hide the demo this new pass leads to
        // (2026-11-11 test: redoing step 2 never reached the three lines).
        const freshAttempt = () => {
          setRestoredPass(false);
          setWatchPhase('idle');
          setWatchRowIds([]);
          setWatchNote('');
        };
        const guideMe = async () => {
          freshAttempt();
          setOutcome({ kind: 'idle' });
          setShowHint(false);
          setAutoStageIdx(0);
          // Snapshot the rules already in the base, so "create the automation" is
          // graded on the learner ADDING one. Best effort: if the call fails (dev
          // server, offline), fall back to no baseline rather than blocking.
          if (!guidedBaselineTaken.current) {
            guidedBaseline.current = await listAutomationRuleIds().catch(() => []);
            guidedBaselineTaken.current = true;
          }
          setAutoMode('guided');
          // Get out of the way at once: stage 1 asks for a NEW automation rule, and
          // the button that creates one is behind this panel. The toolbar carries
          // the stage instruction and its Check, so nothing is lost by shrinking.
          onRequestFloat?.();
        };
        const justCheck = () => {
          freshAttempt();
          setOutcome({ kind: 'idle' });
          setAutoMode('check');
        };
        return {
          instruction: text,
          onBack,
          // Mirror the choice screen's two options as a dropdown on the primary.
          primary: {
            icon: 'next',
            title: t('course.automation.build'),
            onClick: guideMe,
            menu: [
              { label: t('course.automation.guide_me'), onClick: guideMe },
              { label: t('course.automation.just_check'), onClick: justCheck },
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
            : {
                icon: 'check',
                title: t('course.automation.check_mine'),
                onClick: onVerify,
                busy: verifying,
              },
          feedback: passFeedback(step.successMessage),
        };
      }
      // Guided stepper.
      const stage = stages[autoStageIdx];
      const lastStage = autoStageIdx >= stages.length - 1;
      const passMsg = lastStage ? step.successMessage : t('course.automation.stage_complete');
      let primary: FloatControls['primary'] | undefined;
      if (passed && !lastStage)
        primary = { icon: 'next', title: t('course.automation.next_stage'), onClick: advanceStage };
      else if (passed && lastStage) primary = forwardPrimary;
      else
        primary = {
          icon: 'check',
          title: t('course.check'),
          onClick: verifyAutomationStage,
          busy: verifying,
        };
      return {
        instruction: stage?.instruction ?? stage?.title ?? text,
        onBack: () => {
          setOutcome({ kind: 'idle' });
          setShowHint(false);
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
        : { icon: 'check', title: t('course.verify'), onClick: onVerify, busy: verifying },
      feedback:
        passed && forward.kind === 'website'
          ? { kind: 'pass', text: `${feedbackText(outcome, step.successMessage)} ${forward.note}` }
          : passFeedback(step.successMessage),
    };
  };

  // ⚠️ This list is MAINTAINED BY HAND — the lint rule that would keep it honest is
  // switched off below, because `buildFloatControls` is rebuilt on every render and
  // depending on it would loop. So every value the builder reads must be listed here
  // or the toolbar keeps rendering the previous controls.
  //
  // That is not theoretical: `activeView` was missing, and the wrong-view case showed
  // its message (rendered in the banner, which re-renders freely) while the button
  // stayed enabled and said 'Make a change' (rendered by App from the last controls
  // reported up). Message right, button wrong, and the build clean throughout —
  // found 2026-09-01. If you add state that the builder reads, add it here too.
  useEffect(() => {
    onFloatControls?.(buildFloatControls());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    stepId,
    manifest,
    html,
    autoMode,
    autoStageIdx,
    outcome,
    verifying,
    demoRunning,
    demoStatus,
    seededDocId,
    demoDone,
    rewound,
    showHint,
    watchPhase,
    watchNote,
    watchRowIds,
    activeTable,
    activeView,
  ]);

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
          <div style={{ marginBottom: 16 }}>{t('course.loading')}</div>
        </div>
      </div>
    );
  }

  // Working body (an exercise's compact banner, or a full-height page with something
  // to do): content + optional stage progress / demo status / hint / feedback. Every action (Back, Verify, Run, Next, the guided-build choice)
  // lives in the plugin header and the floating toolbar — see buildFloatControls.
  // Once the watch demo takes over, it replaces the step/stage body: the exercise is
  // already passed and the learner's attention belongs on the rows landing.
  const guided = isAutomationGuided && autoMode === 'guided' && !watching;
  // The watch demo owns the body once the exercise passes. Its opening line is the
  // grade's own pass message: the check succeeded, and the demo is what proves it.
  // On a full-height page the step's H1 stays at the top while a stage or the watch
  // demo replaces the rest of the body.
  // The H1 is taken out of the body so the "you are on the wrong table" note can sit
  // right under it.
  const pageH1 = mode === 'course' ? (html.match(/^\s*<h1>[\s\S]*?<\/h1>/)?.[0] ?? '') : '';
  const bodyHtml = watching
    ? (wPhase === 'ready' && passed ? `<p>${feedbackText(outcome, step.successMessage)}</p>` : '') +
      watch!.html
    : guided
      ? stages[autoStageIdx]?.html || ''
      : html.slice(pageH1.length);
  // The instruction that goes with that body — the same one the toolbar shows.
  const bodyInstruction = watching
    ? watch!.instruction
    : guided
      ? stages[autoStageIdx]?.instruction
      : step.instruction;
  const feedbackMsg = guided
    ? autoStageIdx >= stages.length - 1
      ? step.successMessage
      : t('course.automation.stage_complete')
    : step.successMessage;
  // While waiting on the press, the status line carries the "open Line items" nudge
  // (empty once they're there, or if the host's table can't be read).
  //
  // `demoStatus` is live React state, so it is gone the moment the learner pages away
  // and comes back — which left an action step looking untouched even though its mark
  // had persisted and its button still said "Start over". So fall back to the step's
  // stored done-message, the same one the floating toolbar shows.
  const statusLine = watching
    ? watchNote
    : demoStatus || (demoDone ? (step.demoDoneMessage ?? '') : '');
  // "You're looking at X — open Y first": a note at the top of the page (under its
  // H1) or of the banner, not a status line under the text, where it was missed.
  const placeNote = watching ? watchTableNote : tableNote;
  const feedbackLine = watching
    ? wPhase === 'linked'
      ? `✅ ${watch!.successMessage ?? ''}${forward.kind === 'website' ? ` ${forward.note}` : ''}`
      : null
    : outcome.kind === 'idle'
      ? null
      : passed && forward.kind === 'website'
        ? `${feedbackText(outcome, step.successMessage)} ${forward.note}`
        : feedbackText(outcome, feedbackMsg);

  // The working body — stage progress, the text and its "Your turn:" block, the
  // widgets, status, hint and verify result. The same on both layouts: an exercise
  // shows it in the compact banner, a full-height page that still has something to
  // do or check (a grade, a plugin action) shows it as its page.
  const workingBody = (
    <>
      {pageH1 && <div dangerouslySetInnerHTML={{ __html: pageH1 }} />}
      {placeNote && <div style={S.placeNote}>{placeNote}</div>}
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
      <InstructionBlock html={bodyInstruction} />
      {isColleagueSetup && <ColleagueSetup onVerified={markDemoDone} />}
      {isColleagueWindow && step.colleagueWindow && (
        <ColleagueWindow
          surface={step.colleagueWindow.surface}
          caption={step.colleagueWindow.caption}
        />
      )}
      {statusLine && <div style={S.demoStatus}>{statusLine}</div>}
      {/* An action step that is done hands back to the website — say so here too,
          not only in the floating toolbar. A passed verify already carries it. */}
      {!watching && demoDone && forward.kind === 'website' && !feedbackLine && (
        <div style={S.demoStatus}>{forward.note}</div>
      )}
      {/* Authored HTML, like the step body: a hint can show SeaTable's own icons. */}
      {showHint && step.hint && !watching && (
        <div style={S.hint} dangerouslySetInnerHTML={{ __html: step.hint }} />
      )}
      {/* A verify result reads like the rest of the step — same size, no bold, no
          box: its leading symbol (✅ pass, ❌ fail, ⚠️ missing) already says which. */}
      {feedbackLine && <div style={{ marginTop: 8 }}>{feedbackLine}</div>}
    </>
  );

  // A full-height page with something to do or check: the working body, at full height.
  // (The windows on Malika and the token setup keep their own page below.)
  const interactivePage = interactivePageFor(step);
  if (mode === 'course' && interactivePage) {
    return (
      <div style={S.coursePage}>
        <div style={{ ...S.courseInner, fontSize: 15, lineHeight: 1.5 }}>
          {loadNote && <div style={S.loadNote}>{loadNote}</div>}
          {workingBody}
        </div>
      </div>
    );
  }

  // Lesson page (full height): content only — Back/Continue live in the plugin
  // header (and the floating toolbar), driven by buildFloatControls above.
  if (mode === 'course') {
    // A course's Introduction says up front when this base lacks what the course
    // works on. A warning, not a lock; nothing to say for a course without steps.
    // No list in the note: in the wrong base everything is missing, and the check
    // only knows the tables the steps name, so a list would look complete without
    // being so (2026-11-11).
    const missing = step.id === 'introduction' ? missingBaseParts(manifest.steps) : [];
    // Authored text + our own link (the course page, where the base is downloaded).
    const siteLink = manifest && courseWebsiteLink(manifest.courseId);
    const missingNote = missing.length
      ? t('course.intro.missing') +
        (siteLink ? ` ${t('course.intro.missing_link', { link: siteLink })}` : '')
      : '';
    return (
      <div style={S.coursePage}>
        <div style={S.courseInner}>
          {loadNote && <div style={S.loadNote}>{loadNote}</div>}
          <div dangerouslySetInnerHTML={{ __html: html }} />
          {missingNote && (
            <div
              style={{ ...S.placeNote, marginTop: 22 }}
              dangerouslySetInnerHTML={{ __html: missingNote }}
            />
          )}
          <InstructionBlock html={step.instruction} />
          {showHint && step.hint && (
            <div style={S.hint} dangerouslySetInnerHTML={{ __html: step.hint }} />
          )}
          {/* A window on the colleague belongs on THIS layout, not in the compact
              exercise banner: the notification panel is as tall as its content, and
              inside the banner it brought its own scrollbar on top of the page's. */}
          {isColleagueWindow && step.colleagueWindow && (
            <ColleagueWindow
              surface={step.colleagueWindow.surface}
              caption={step.colleagueWindow.caption}
              onSuccess={() => !demoDone && markDemoDone()}
              onFailure={() => demoDone && unmarkDemoDone()}
            />
          )}
          {isColleagueSetup && <ColleagueSetup onVerified={markDemoDone} />}
          {(isColleagueWindow || isColleagueSetup) && demoDone && step.demoDoneMessage && (
            // Clear of the window above it, as the closer below is (2026-11-11 test).
            <div style={{ ...S.demoStatus, marginTop: 16 }}>{step.demoDoneMessage}</div>
          )}
          {/* On a page that waits for something, the way on is said once it is there. */}
          {forward.kind === 'website' && (!isColleagueWindow || demoDone) && (
            <div style={S.websiteHandoffBlock}>{forward.note}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={S.banner}>
      <div style={S.bannerMain} ref={bannerRef}>
        {workingBody}
      </div>
    </div>
  );
};

function feedbackText(o: Outcome, successMessage?: string): string {
  switch (o.kind) {
    case 'pass':
      return t('course.feedback.pass', {
        message: successMessage ?? t('course.feedback.pass_default'),
      });
    case 'fail':
      return t('course.feedback.fail', { reason: o.reason });
    case 'missing':
      return t('course.feedback.missing', { what: o.what });
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
  demoStatus: { marginTop: 8, color: '#333' },
  // "Continue on the website" closer (website-unfolding handoff), under a full page.
  // Plain text, as on the action pages: same size as the page, no box.
  websiteHandoffBlock: { marginTop: 16, color: '#333' },
  banner: {
    height: '100%',
    boxSizing: 'border-box',
    overflowY: 'auto',
    background: '#fff',
    padding: '12px 18px',
  },
  // The step's text size, set once for the whole banner: the instruction, a widget
  // under it (the colleague's token, her window) and the status line all read at one
  // size instead of three.
  bannerMain: { minWidth: 0, fontSize: 15, lineHeight: 1.5 },
  stageProgress: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  instruction: { fontSize: 15, lineHeight: 1.5, color: '#222' },
  // Same look as the Introduction's "not supported by the plugin" note.
  placeNote: {
    marginBottom: 12,
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 14,
    lineHeight: 1.5,
    background: '#fff4e5',
    color: '#8a5300',
    border: '1px solid #ffd9a8',
  },
  todo: {
    marginTop: 12,
    marginLeft: 4,
    paddingLeft: 12,
    borderLeft: '4px solid #ff8000',
    color: '#222',
  },
  todoLabel: { fontWeight: 600 },
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
