import React, { useEffect, useState } from 'react';
import styles from '../../../styles/template-styles/Plugin.module.scss';
import stylesPPresets from '../../../styles/template-styles/PluginPresets.module.scss';
import { IHeaderProps } from '../../../utils/template-interfaces/Header.interface';
import { HiOutlineChevronDoubleRight } from 'react-icons/hi2';
import intl from 'react-intl-universal';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from '../../../locale';
const { [DEFAULT_LOCALE]: d } = AVAILABLE_LOCALES;

const Header: React.FC<IHeaderProps> = (props) => {
  const { presetName, isShowPresets, onTogglePresets, togglePlugin, stepTitle, controls, onFloat } =
    props;

  // The step's actions (back / verify / advance) live here so the docked plugin
  // matches the floating toolbar. The "Guide me / Just check it" choice reuses the
  // same dropdown menu the toolbar uses.
  const [menuOpen, setMenuOpen] = useState(false);
  const primary = controls?.primary;
  useEffect(() => {
    setMenuOpen(false);
  }, [primary?.title]);

  const primaryGlyph =
    primary?.icon === 'check'
      ? 'dtable-icon-check-mark'
      : primary?.icon === 'run'
        ? 'dtable-icon-refresh'
        : 'dtable-icon-right';

  return (
    <div className={styles.plugin_header}>
      <div
        className="d-flex align-items-center justify-content-start"
        style={{ minWidth: 0, flex: 1 }}>
        <div className={`align-items-center ${isShowPresets ? 'd-none' : 'd-flex'} `}>
          <button
            className={stylesPPresets.presets_uncollapse_btn2_settings}
            onClick={onTogglePresets}>
            <HiOutlineChevronDoubleRight />
          </button>
        </div>
        {/* The current step's name (falls back to the course name). */}
        <div className={styles.plugin_header_pluginName} style={{ flexShrink: 0 }}>
          <p className="font-weight-bold">{stepTitle || presetName}</p>
        </div>
      </div>

      <div
        className={`d-flex align-items-center justify-content-end ${styles.plugin_header_settings}`}>
        {/* Step actions — Back · Hint · the one primary (verify / run / advance),
            with the guided-build choice as a dropdown. Mirrors the floating toolbar,
            but with text labels since the full-width header has the room. */}
        {controls && (controls.onBack || primary || controls.help) && (
          <div style={hs.actions}>
            <button
              type="button"
              style={{ ...hs.ghost, ...(controls.onBack ? null : hs.off) }}
              disabled={!controls.onBack}
              onClick={controls.onBack}>
              <i className="dtable-font dtable-icon-left" style={hs.glyph} />
              <span>Back</span>
            </button>
            {controls.help && (
              <button
                type="button"
                style={{ ...hs.ghost, ...(controls.help.shown ? hs.ghostActive : null) }}
                onClick={controls.help.toggle}>
                <i className="dtable-font dtable-icon-help-center" style={hs.glyph} />
                <span>{controls.help.shown ? 'Hide hint' : 'Hint'}</span>
              </button>
            )}
            {primary && (
              <div style={{ position: 'relative' }}>
                <button
                  type="button"
                  style={{ ...hs.primary, ...(primary.busy || primary.disabled ? hs.off : null) }}
                  title={primary.busy ? 'Checking…' : primary.title}
                  disabled={primary.busy || primary.disabled}
                  onClick={() => {
                    if (!primary.menu) return primary.onClick();
                    setMenuOpen((v) => !v);
                  }}>
                  <i className={`dtable-font ${primaryGlyph}`} style={hs.glyph} />
                  <span>{primary.busy ? 'Checking…' : primary.title}</span>
                  {primary.menu && (
                    <i className="dtable-font dtable-icon-drop-down" style={hs.caret} />
                  )}
                </button>
                {menuOpen && primary.menu && (
                  <div style={hs.menu}>
                    {primary.menu.map((opt) => (
                      <button
                        key={opt.label}
                        type="button"
                        style={hs.menuItem}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#f2f4f7')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        onClick={() => {
                          setMenuOpen(false);
                          opt.onClick();
                        }}>
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <span style={hs.divider} />
          </div>
        )}

        {/* Window controls: shrink-to-toolbar · close. */}
        {onFloat && (
          <span
            className={styles.plugin_header_icon_btn}
            onClick={onFloat}
            title="Shrink to a movable toolbar">
            <span className="dtable-font dtable-icon-full-screen" style={{ border: 'none' }}></span>
          </span>
        )}
        <span className={styles.plugin_header_icon_btn} onClick={togglePlugin}>
          <span
            className="dtable-font dtable-icon-x"
            style={{ border: 'none' }}
            title={intl.get('custom_plugin.close').d(`${d.custom_plugin.close}`)}></span>
        </span>
      </div>
    </div>
  );
};

// Header-themed (light) styling for the step-action cluster — the toolbar has its
// own dark-on-emerald variant in app.tsx.
const hs: Record<string, React.CSSProperties> = {
  actions: { display: 'flex', alignItems: 'center', gap: 4 },
  ghost: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    height: 28,
    padding: '0 10px',
    background: 'transparent',
    border: 'none',
    borderRadius: 6,
    color: '#444',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  ghostActive: { background: '#eef4ff', color: '#1c4e80' },
  primary: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    height: 28,
    padding: '0 12px',
    background: '#ff8000',
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  off: { opacity: 0.4, cursor: 'default' },
  glyph: { fontSize: 15, lineHeight: 1 },
  caret: { fontSize: 12, lineHeight: 1, marginLeft: -1 },
  divider: { width: 1, height: 20, background: '#e0e0e0', margin: '0 4px' },
  menu: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 4,
    minWidth: 180,
    background: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: 8,
    boxShadow: '0 4px 14px rgba(0,0,0,0.15)',
    padding: 4,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    zIndex: 20,
  },
  menuItem: {
    textAlign: 'left',
    padding: '7px 10px',
    background: 'transparent',
    border: 'none',
    borderRadius: 6,
    color: '#333',
    fontSize: 13,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
};

export default Header;
