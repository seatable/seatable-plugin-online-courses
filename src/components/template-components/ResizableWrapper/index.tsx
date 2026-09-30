import React, { useEffect, useRef, useState } from 'react';
import styles from '../../../styles/template-styles/Plugin.module.scss';
import { IResizableWrapper } from '../../../utils/template-interfaces/ResizableWrapper.interface';

// The range the handle can size the window to: a sliver of header at the least, and
// never past the top of the viewport.
export const MIN_PLUGIN_HEIGHT = 50;
export function clampHeight(px: number): number {
  return Math.min(Math.max(px, MIN_PLUGIN_HEIGHT), window.innerHeight - 18);
}

const ResizableWrapper: React.FC<IResizableWrapper> = ({
  children,
  floating = false,
  onUserResize,
}) => {
  const [allowTextSelection, setAllowTextSelection] = useState<boolean>(true);
  const modalRef = useRef<null | HTMLDivElement>(null);
  const modalTop = useRef<null | HTMLDivElement>(null);
  // The listeners below are attached once; a ref keeps them calling the latest callback.
  const onUserResizeRef = useRef(onUserResize);
  onUserResizeRef.current = onUserResize;

  useEffect(() => {
    let resizableModal = modalRef.current;
    let pluginWrapper: null | HTMLDivElement = document.querySelector('#plugin-wrapper');
    let style;
    let height: number;

    if (resizableModal) {
      style = window.getComputedStyle(resizableModal);
      height = parseInt(style.height, 10);
    }

    let yCord = 0;
    let topResizer = modalTop.current;

    const onMouseMoveTopResize = (event: MouseEvent) => {
      const dy = event.clientY - yCord;
      // Clamp as we go. The height used to keep counting past the limits while the
      // window simply stopped following — so the value handed over on release could
      // lie beyond the top or the bottom of the screen, and the plugin applied it.
      height = clampHeight(height - dy);
      yCord = event.clientY;
      if (resizableModal) {
        resizableModal.style.height = `${height}px`;
        if (pluginWrapper) {
          pluginWrapper.style.top = `calc(100% - ${height}px)`;
        }
      }
    };
    const onMouseUpTopResize = () => {
      document.removeEventListener('mousemove', onMouseMoveTopResize);
      document.removeEventListener('mouseup', onMouseUpTopResize);
      setAllowTextSelection(true);
      // Marks the window as sized by hand — the Welcome tour's handle exercise reads it.
      if (pluginWrapper) pluginWrapper.dataset.userResized = '1';
      onUserResizeRef.current?.(height);
    };
    const onMouseDownTopResize = (event: MouseEvent) => {
      setAllowTextSelection(false);
      yCord = event.clientY;
      if (resizableModal) {
        style = window.getComputedStyle(resizableModal);
        // Start from the height the window has NOW. It used to be read once, at mount:
        // the plugin opens at full height and then shrinks itself to a banner on an
        // exercise, so the handle still believed it was at full height, and every
        // pull upwards computed a height past the maximum and was refused — the panel
        // looked stuck.
        height = parseInt(style.height, 10);
        resizableModal.style.bottom = style.bottom;
        resizableModal.style.top = '';
      }
      document.addEventListener('mousemove', onMouseMoveTopResize);
      document.addEventListener('mouseup', onMouseUpTopResize);
    };
    topResizer?.addEventListener('mousedown', onMouseDownTopResize);

    return () => {
      setAllowTextSelection(true);
      topResizer?.removeEventListener('mousedown', onMouseDownTopResize);
    };
  }, [modalRef]);

  return (
    <div
      ref={modalRef}
      className={styles.plugin_wrapper}
      style={{ userSelect: allowTextSelection ? 'auto' : 'none' }}>
      {/* draggable resize handle — hidden (NOT unmounted) while floating: the puck
          moves rather than resizes, but keeping the node mounted preserves the
          mousedown listener (attached once), so resize still works after restoring. */}
      <div
        ref={modalTop}
        className={styles.plugin_draggable}
        style={floating ? { display: 'none' } : undefined}>
        <span></span>
        <span></span>
      </div>
      {children}
    </div>
  );
};

export default ResizableWrapper;
