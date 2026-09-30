import React, { useEffect, useRef, useState } from 'react';
import {
  CourseManifest,
  CourseStep,
  EXAMPLE_FIX_LABEL,
  EXAMPLE_WRITE_LABEL,
  fetchStepHtml,
  findStep,
  stepIndex,
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
  tableHasView,
} from '../../../utils/custom-utils/watchAutomation';
import { FloatControls } from '../../../utils/custom-interfaces/FloatControls';

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
    if (step.type === 'course' && !step.colleagueWindow && step.demo !== 'colleague-setup') {
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
      return { icon: 'run', title: 'Start over', onClick: startOver, busy: demoRunning };
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
          ? `Open the “${step.watchView}” view first`
          : `Open “${step.watchTable}” first`,
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
    setDemoStatus('Preparing…');
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
          ? '✅ The delivery note is in your base, with no lines and no file. Push one from the API explorer, then verify.'
          : res.linked
            ? '✅ A short delivery is waiting. Run your rule, then verify.'
            : '⚠️ The delivery is there, but its line has not been linked yet — check the automation you built in step 2, then run your rule.'
      );
    } catch (err: any) {
      setDemoStatus(`❌ ${err?.message || 'Could not prepare the delivery.'}`);
    }
    setDemoRunning(false);
  };

  // --- webhook-burst action (Step 5) -----------------------------------------
  const runBurst = async () => {
    if (demoRunning || !step?.burst) return;
    setDemoRunning(true);
    setDemoStatus('Working…');
    try {
      const res = await webhookBurst(step.burst, setDemoStatus);
      setDemoStatus(
        `✅ Done — ${res.operations} changes, so ${res.operations} requests to read at the other end.`
      );
      markDemoDone();
    } catch (err: any) {
      setDemoStatus(`❌ ${err?.message || 'Could not make the change.'}`);
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
    setDemoStatus('Working…');
    try {
      const res = await colleagueStoreWrite(step.colleagueWrite, setDemoStatus);
      if (step.colleagueReply) {
        setDemoStatus('Malika is replying…');
        await colleagueReply(step.colleagueReply);
      }
      for (const side of step.colleagueSideWrites ?? []) {
        setDemoStatus('Malika updates a few other customers…');
        await colleagueStoreWrite(side, () => undefined, { skipIfUnchanged: true });
      }
      markDemoDone();
      setDemoStatus(
        step.demoDoneMessage ??
          `✅ Written on row ${res.rowId}. Now open the base log and read the entry: does it name the row, ` +
            'is it signed by her, and does its menu offer Restore?'
      );
    } catch (err: any) {
      setDemoStatus(`❌ ${err?.message || 'Could not make the change as the colleague.'}`);
    }
    setDemoRunning(false);
  };

  // --- rewind action (Step 4) ------------------------------------------------
  const runRewind = async () => {
    if (demoRunning || !step?.rewind) return;
    setDemoRunning(true);
    setDemoStatus('Rewinding…');
    try {
      const res = await rewindDelivery(step.rewind, setDemoStatus);
      setRewound(true);
      if (manifest) setCourseFlag(manifest.courseId, REWOUND_FLAG, true);
      setDemoStatus(
        res.document || res.lines
          ? `✅ ${res.lines} line${res.lines === 1 ? '' : 's'} and the document removed${
              res.products ? ', stock put back' : ''
            }. Now receive the delivery again from the app.`
          : '✅ Nothing left to remove — that delivery is already out of your base. Receive it again from the app.'
      );
    } catch (err: any) {
      setDemoStatus(`❌ ${err?.message || 'Could not rewind the delivery.'}`);
    }
    setDemoRunning(false);
  };

  // The safety net REPLACES what the extraction produced rather than adding to it,
  // so a run that wrote two lines out of three doesn't leave the base with five.
  const runLoadExample = async () => {
    if (demoRunning || !step?.example || !step?.rewind) return;
    setDemoRunning(true);
    setDemoStatus('Writing…');
    try {
      const res = await reloadDeliveryLines(step.rewind, step.example.rows, setDemoStatus);
      const reference = step.rewind.document.reference;
      const written = `${res.added} line${res.added === 1 ? '' : 's'} written${
        res.removed ? `, replacing the ${res.removed} the extraction produced` : ''
      }`;
      // Whether these lines can attach is the whole point of the step, so say it
      // rather than leave the learner to notice an empty Document column.
      setDemoStatus(
        res.documentFound
          ? `✅ ${written}${
              res.documentLabelled
                ? `, and ${reference} put on your document so your rule can attach them.`
                : '.'
            }`
          : `⚠️ ${written} — but no document carries ${reference}, so your rule has nothing to ` +
              `attach them to. Create the delivery note first, then write the lines again.`
      );
      // Only a lifecycle step owns this flag; on Step 4 the safety net rides inside a
      // graded step and must not mark it done.
      if (isWriteLines) markDemoDone();
    } catch (err: any) {
      setDemoStatus(`❌ ${err?.message || 'Could not write the lines.'}`);
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
      ? `You’re looking at “${activeTable}”. Open the “${watch.table_name}” table so you can watch ` +
        `the lines land — then add them.`
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
    ? `You’re looking at “${activeTable}”. Open “${step!.watchTable}” first, or you will miss what happens.`
    : wrongView
      ? `Open the “${step!.watchView}” view of “${step!.watchTable}” first — in this one the change ` +
        `happens off-screen and you will miss it.`
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
        setWatchNote(
          `Waiting for your automation… ${s.total - s.pending}/${s.total} lines linked.`
        ),
    });
    if (outcomeLinks.kind === 'linked') {
      setWatchNote(`✅ ${watch.link_columns.join(' and ')} filled in on all ${n} lines.`);
      setWatchPhase('linked');
      return;
    }
    const { pending, total, missing } = outcomeLinks.progress;
    setWatchNote(
      `⏳ ${total - pending}/${total} lines linked — ${missing.join(' and ')} still empty. ` +
        `Automations can take a moment; give it a few seconds and look again. If it stays empty, ` +
        `check your rule's conditions and its Add links actions.`
    );
    setWatchPhase('stalled');
  };

  const runWatch = async () => {
    if (!watch || watchPhase === 'running') return;
    setWatchPhase('running');
    setWatchNote('Writing the delivery lines…');
    try {
      const rowIds = await appendRowsTracked(watch.table_name, watch.rows);
      setWatchRowIds(rowIds);
      if (!rowIds.length) throw new Error('The new lines could not be found after writing them.');
      setWatchNote(`Added ${rowIds.length} lines. Waiting for your automation…`);
      await awaitWatchLinks(rowIds);
    } catch (err: any) {
      setWatchNote(`❌ ${err?.message || 'Could not add the delivery lines.'}`);
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
    const text = step.instruction ?? htmlToText(html);
    // Forward after a pass: an in-plugin Next, else (website handoff) no button —
    // the closer surfaces in `feedback` instead.
    const forwardPrimary: FloatControls['primary'] | undefined =
      forward.kind === 'next'
        ? { icon: 'next', title: 'Next', onClick: () => onSelectStep(forward.step.id) }
        : undefined;
    const passFeedback = (msg?: string): FloatControls['feedback'] =>
      outcome.kind !== 'idle'
        ? { kind: outcome.kind, text: feedbackText(outcome, msg) }
        : undefined;

    // Lesson page: only a forward. A window on Malika moves on in-plugin only once
    // it has shown what it is there for.
    if (step.type === 'course' && !isColleagueSetup)
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
      const watchText =
        (wPhase === 'ready' && watchTableNote) || watch!.instruction || htmlToText(watch!.html);
      let primary: FloatControls['primary'] | undefined;
      if (wPhase === 'ready')
        primary = { icon: 'run', title: 'Add the delivery lines', onClick: runWatch };
      else if (wPhase === 'running')
        primary = { icon: 'run', title: 'Working…', onClick: () => {}, busy: true };
      else if (wPhase === 'stalled')
        primary = { icon: 'check', title: 'Look again', onClick: recheckWatch };
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
          ? { kind: 'pass', text: step.demoDoneMessage ?? 'Your colleague is configured.' }
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
        title: step.demoLabel ?? 'Prepare the delivery',
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
          primary: actionPrimary(step.demoLabel ?? 'Prepare the delivery', runSeedDiscrepancy),
          feedback: actionFeedback(),
        };
      }
      return {
        instruction: text,
        onBack,
        primary: passed
          ? forwardPrimary
          : seededDocId
            ? { icon: 'check', title: 'Verify', onClick: onVerify, busy: verifying }
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
        primary: actionPrimary(step.demoLabel ?? 'Write the lines', runLoadExample),
        feedback: actionFeedback(),
      };
    }

    // Colleague-write experiment (Course 3): one action, nothing graded — the
    // result is read in the base log, not here.
    if (isColleagueWrite) {
      return {
        instruction: text,
        onBack,
        primary: actionPrimary(step.demoLabel ?? 'Let the colleague edit', runColleagueWrite),
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
        primary: actionPrimary('Make a change', runBurst),
        feedback: actionFeedback(),
      };
    }

    // Rewind step (Step 4): take the delivery out, then verify what the AI put
    // back. The safety net rides along in the primary's menu — the extraction may
    // misfire at any point, and the learner shouldn't have to go looking for it.
    if (isRewind) {
      // Name the safety net for what it would actually do right now: write the
      // lines when the extraction left none, fix them when it produced some.
      const label = countDeliveryLines(step.rewind!) ? EXAMPLE_FIX_LABEL : EXAMPLE_WRITE_LABEL;
      const loadExample = { label, onClick: runLoadExample };
      let primary: FloatControls['primary'] | undefined;
      if (passed) primary = forwardPrimary;
      // Before the rewind the primary just fires: the seeded lines are still there,
      // nothing has been extracted, and a dropdown in front of the one action of the
      // step would be friction offering a safety net against nothing.
      else if (!rewound)
        primary = {
          icon: 'run',
          title: 'Rewind the delivery',
          onClick: runRewind,
          busy: demoRunning,
        };
      else
        primary = {
          icon: 'check',
          title: 'Verify',
          onClick: onVerify,
          busy: verifying || demoRunning,
          menu: [
            { label: 'Verify', onClick: onVerify },
            loadExample,
            { label: 'Rewind again', onClick: runRewind },
          ],
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
        const guideMe = async () => {
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
      if (passed && !lastStage)
        primary = { icon: 'next', title: 'Next stage', onClick: advanceStage };
      else if (passed && lastStage) primary = forwardPrimary;
      else
        primary = {
          icon: 'check',
          title: 'Check',
          onClick: verifyAutomationStage,
          busy: verifying,
        };
      return {
        instruction: stage?.instruction ?? htmlToText(stage?.html || ''),
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
        : { icon: 'check', title: 'Verify', onClick: onVerify, busy: verifying },
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
            <div style={S.demoStatus}>{step.demoDoneMessage}</div>
          )}
          {/* On a page that waits for something, the way on is said once it is there. */}
          {forward.kind === 'website' && (!isColleagueWindow || demoDone) && (
            <div style={S.websiteHandoffBlock}>{forward.note}</div>
          )}
        </div>
      </div>
    );
  }

  // Exercise (compact banner): content + optional stage progress / demo status /
  // hint / feedback. Every action (Back, Verify, Run, Next, the guided-build choice)
  // lives in the plugin header and the floating toolbar — see buildFloatControls.
  // Once the watch demo takes over, it replaces the step/stage body: the exercise is
  // already passed and the learner's attention belongs on the rows landing.
  const guided = isAutomationGuided && autoMode === 'guided' && !watching;
  // The watch demo owns the body once the exercise passes. Its opening line is the
  // grade's own pass message: the check succeeded, and the demo is what proves it.
  const bodyHtml = watching
    ? (wPhase === 'ready' && passed ? `<p>${feedbackText(outcome, step.successMessage)}</p>` : '') +
      watch!.html
    : guided
      ? stages[autoStageIdx]?.html || ''
      : html;
  const feedbackMsg = guided
    ? autoStageIdx >= stages.length - 1
      ? step.successMessage
      : 'Stage complete — on to the next.'
    : step.successMessage;
  // While waiting on the press, the status line carries the "open Line items" nudge
  // (empty once they're there, or if the host's table can't be read).
  //
  // `demoStatus` is live React state, so it is gone the moment the learner pages away
  // and comes back — which left an action step looking untouched even though its mark
  // had persisted and its button still said "Start over". So fall back to the step's
  // stored done-message, the same one the floating toolbar shows.
  const statusLine = watching
    ? watchTableNote || watchNote
    : demoStatus || tableNote || (demoDone ? (step.demoDoneMessage ?? '') : '');
  const feedbackLine = watching
    ? wPhase === 'linked'
      ? `✅ ${watch!.successMessage ?? ''}${forward.kind === 'website' ? ` ${forward.note}` : ''}`
      : null
    : outcome.kind === 'idle'
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
