export interface IResizableWrapper {
  children: React.ReactNode;
  // When floating (shrunk to a draggable icon) the top resize handle is hidden —
  // the puck is dragged, not resized.
  floating?: boolean;
  // Called with the new height (px) when the learner lets go of the resize handle.
  onUserResize?: (px: number) => void;
}
