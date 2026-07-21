/**
 * The controls the floating toolbar needs from the (controlled) course runner.
 *
 * When the plugin is shrunk to its floating toolbar, the learner must be able to
 * read the instruction, go back, and — crucially — VERIFY the step WITHOUT
 * re-expanding the whole plugin. Those actions live inside OnlineCourse (they vary
 * per step type: grade-verify vs. run-a-demo vs. advance-a-stage), so the runner
 * reports this descriptor UP to App, which renders the toolbar from it. App owns the
 * toolbar geometry/drag/click-through; the runner owns what the buttons DO.
 */
export interface FloatControls {
  /** Current step's (or automation sub-stage's) instruction, plain text. */
  instruction: string;
  /** Back handler — absent when there's nothing to go back to (disables the button). */
  onBack?: () => void;
  /** The one context-aware primary action (verify / run a demo / advance). */
  primary?: {
    /** Picks the glyph: a check to verify, a run for demos, a right-arrow to advance. */
    icon: 'check' | 'run' | 'next';
    /** Button tooltip / accessible label. */
    title: string;
    onClick: () => void;
    /** In flight (e.g. grading) — shows a disabled/pending state. */
    busy?: boolean;
    disabled?: boolean;
    /**
     * When the primary offers a CHOICE (e.g. the automation step's "Guide me" vs
     * "Just check it"), the toolbar opens this as a small menu instead of firing
     * `onClick` directly. Shown with a caret so it reads as a dropdown.
     */
    menu?: { label: string; onClick: () => void }[];
  };
  /**
   * Reveal-on-demand hint (Help), when the step has one. Toggled from the header
   * (a labelled button; the hint shows in the body) or the floating toolbar (a
   * toggle inside the info popover, between the instruction and the check result).
   */
  help?: { shown: boolean; toggle: () => void; text: string };
  /** Last result, surfaced in the info popover (and tints the primary on failure). */
  feedback?: { kind: 'pass' | 'fail' | 'missing' | 'info'; text: string };
}
