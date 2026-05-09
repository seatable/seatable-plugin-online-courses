import React, { useState, useEffect } from 'react';
import stylesPSettings from '../../../styles/template-styles/PluginSettings.module.scss';
import stylesPresets from '../../../styles/template-styles/PluginPresets.module.scss';
import { IPluginSettingsProps } from '../../../utils/template-interfaces/PluginSettings.interface';
import { HiOutlineChevronDoubleRight } from 'react-icons/hi2';
import intl from 'react-intl-universal';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from '../../../locale';
import PerfIcon from '../../custom-components/shared/PerfIcon';
const { [DEFAULT_LOCALE]: d } = AVAILABLE_LOCALES;

// ---------------------------------------------------------------------------
// Login modal — generates account token from email + password
// ---------------------------------------------------------------------------

const LoginModal: React.FC<{
  onToken: (token: string) => void;
  onClose: () => void;
}> = ({ onToken, onClose }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [showOtp, setShowOtp] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!email || !password) return;
    setError('');
    setLoading(true);

    try {
      const config = (window as any).dtable || {};
      const serverUrl = config.server || '';
      if (!serverUrl) {
        setError('Server URL not available');
        setLoading(false);
        return;
      }

      const body = new URLSearchParams();
      body.append('username', email);
      body.append('password', password);

      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      };
      if (otp) headers['X-SEAFILE-OTP'] = otp;

      const resp = await fetch(`${serverUrl}/api2/auth-token/`, {
        method: 'POST',
        headers,
        body: body.toString(),
      });

      const data = await resp.json();

      if (!resp.ok) {
        const msg = data.non_field_errors?.[0] || data.detail || `Error ${resp.status}`;
        // If 2FA is required, SeaTable returns a specific error
        if (resp.status === 400 && JSON.stringify(data).toLowerCase().includes('two-factor')) {
          setShowOtp(true);
          setError(intl.get('settings.login_2fa_required').d('Two-factor authentication required'));
        } else {
          setError(msg);
        }
        setLoading(false);
        return;
      }

      if (data.token) {
        onToken(data.token);
        onClose();
      } else {
        setError('No token in response');
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
    }
    setLoading(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
      }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: '#fff',
          borderRadius: 8,
          padding: 24,
          width: 340,
          boxShadow: '0 4px 24px rgba(0,0,0,0.2)',
        }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>
          {intl.get('settings.login_title').d('Generate Account Token')}
        </div>

        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
          {intl.get('settings.login_email').d('Email')}
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          style={{
            width: '100%',
            padding: '6px 10px',
            border: '1px solid #ddd',
            borderRadius: 4,
            fontSize: 13,
            marginBottom: 12,
            boxSizing: 'border-box',
          }}
        />

        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
          {intl.get('settings.login_password').d('Password')}
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%',
            padding: '6px 10px',
            border: '1px solid #ddd',
            borderRadius: 4,
            fontSize: 13,
            marginBottom: showOtp ? 12 : 16,
            boxSizing: 'border-box',
          }}
        />

        {showOtp && (
          <>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
              {intl.get('settings.login_otp').d('2FA Code')}
            </label>
            <input
              type="text"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="123456"
              maxLength={6}
              style={{
                width: '100%',
                padding: '6px 10px',
                border: '1px solid #ddd',
                borderRadius: 4,
                fontSize: 13,
                marginBottom: 16,
                boxSizing: 'border-box',
              }}
            />
          </>
        )}

        {error && <div style={{ color: '#dc3545', fontSize: 12, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '6px 16px',
              fontSize: 13,
              border: '1px solid #ddd',
              borderRadius: 4,
              backgroundColor: '#fff',
              cursor: 'pointer',
            }}>
            {intl.get('settings.login_cancel').d('Cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !email || !password}
            style={{
              padding: '6px 16px',
              fontSize: 13,
              border: 'none',
              borderRadius: 4,
              backgroundColor: loading || !email || !password ? '#ccc' : '#ff8000',
              color: '#fff',
              cursor: loading || !email || !password ? 'default' : 'pointer',
            }}>
            {loading
              ? intl.get('settings.login_loading').d('Logging in...')
              : intl.get('settings.login_submit').d('Login')}
          </button>
        </div>

        <p style={{ fontSize: 11, color: '#999', marginTop: 12, marginBottom: 0 }}>
          {intl
            .get('settings.login_disclaimer')
            .d('Your credentials are sent directly to your SeaTable server and are not stored.')}
        </p>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Account token field — shared between assets and performance audit settings
// ---------------------------------------------------------------------------

const AccountTokenField: React.FC<{
  accountToken: string;
  onSave: (token: string) => void;
}> = ({ accountToken, onSave }) => {
  const [tokenInput, setTokenInput] = useState(accountToken || '');
  const [showToken, setShowToken] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const isDirty = tokenInput !== (accountToken || '');

  useEffect(() => {
    setTokenInput(accountToken || '');
  }, [accountToken]);

  const handleSave = () => onSave(tokenInput.trim());

  const handleLoginToken = (token: string) => {
    setTokenInput(token);
    onSave(token);
  };

  return (
    <>
      <label style={{ display: 'block', fontWeight: 600, marginBottom: 4, fontSize: 13 }}>
        {intl.get('settings.account_token').d('Account Token')}
      </label>
      <p style={{ fontSize: 12, color: '#666', margin: '0 0 8px' }}>
        {intl
          .get('settings.account_token_desc')
          .d(
            'Required for the assets and performance audits. Generate one from your SeaTable account settings.'
          )}
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type={showToken ? 'text' : 'password'}
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder={intl.get('settings.account_token_placeholder').d('Enter your account token')}
          style={{
            flex: 1,
            padding: '6px 10px',
            border: '1px solid #ddd',
            borderRadius: 4,
            fontSize: 13,
          }}
        />
        <button
          onClick={() => setShowToken(!showToken)}
          style={{
            padding: '6px 10px',
            border: '1px solid #ddd',
            borderRadius: 4,
            background: '#fff',
            cursor: 'pointer',
            fontSize: 16,
            color: '#666',
            display: 'flex',
            alignItems: 'center',
          }}
          title={
            showToken ? intl.get('settings.hide').d('Hide') : intl.get('settings.show').d('Show')
          }>
          <i className={`dtable-font ${showToken ? 'dtable-icon-eye-slash' : 'dtable-icon-eye'}`} />
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        {isDirty && (
          <button
            onClick={handleSave}
            style={{
              padding: '6px 16px',
              backgroundColor: '#ff8000',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13,
            }}>
            {intl.get('settings.save').d('Save')}
          </button>
        )}
        {accountToken && !isDirty && (
          <span style={{ fontSize: 12, color: '#28a745' }}>
            {intl.get('settings.token_saved').d('Token saved')}
          </span>
        )}
        <span
          onClick={() => setShowLogin(true)}
          style={{
            fontSize: 12,
            color: '#ff8000',
            cursor: 'pointer',
            userSelect: 'none',
            marginLeft: isDirty || (accountToken && !isDirty) ? 'auto' : 0,
          }}>
          {intl.get('settings.login_generate').d('Generate with login')}
        </span>
      </div>

      {showLogin && <LoginModal onToken={handleLoginToken} onClose={() => setShowLogin(false)} />}
    </>
  );
};

// ---------------------------------------------------------------------------
// Main settings panel
// ---------------------------------------------------------------------------

const PluginSettings: React.FC<IPluginSettingsProps> = ({
  isShowSettings,
  onToggleSettings,
  onSaveAccountToken,
  accountToken,
  verifyUrls,
  onVerifyUrlsChange,
  pluginPresets,
  appActiveState,
  allTables,
  auditTableDisplay,
  onAuditTableDisplayChange,
  autoRerun,
  onAutoRerunChange,
  perfRunning,
}) => {
  const activePreset = pluginPresets?.[appActiveState?.activePresetIdx];
  const presetName = activePreset?.name?.toLowerCase() || '';
  const isLinksAudit = presetName.includes('link');
  const isTablesAudit = !isLinksAudit && presetName.includes('table');
  const isAssetsAudit = !isLinksAudit && !isTablesAudit;

  // Account token is needed by Assets audit (URL verification) and by the on-demand
  // Performance analysis embedded in Tables audit (sandbox creation).
  const needsToken = isAssetsAudit || isTablesAudit;

  // Tables audit settings helpers
  const display = auditTableDisplay;

  // Performance analysis staleness detection — compare the row archival threshold
  // currently set against the one that was used at the time of the last performance
  // run. When they differ, the Rows section of the previous result no longer
  // reflects the user's current threshold, so we surface a clickable notification
  // inviting them to rerun.
  const savedPerf: any = activePreset?.customSettings?.savedPerformanceAudit;
  const lastRunThreshold: number | undefined = savedPerf?.rowArchivalThresholdDaysAtRun;
  const currentThreshold: number | undefined = display?.rowArchivalThresholdDays;
  const rowArchivalStale =
    savedPerf != null &&
    lastRunThreshold != null &&
    currentThreshold != null &&
    lastRunThreshold !== currentThreshold;
  const triggerPerfRerun = () => {
    if (!display || !onAuditTableDisplayChange) return;
    onAuditTableDisplayChange({ ...display, perfRerunAt: Date.now() });
  };

  const toggleTable = (tableId: string) => {
    if (!display || !onAuditTableDisplayChange) return;
    const selected = display.selectedTables.includes(tableId)
      ? display.selectedTables.filter((id) => id !== tableId)
      : [...display.selectedTables, tableId];
    onAuditTableDisplayChange({
      ...display,
      selectedTables: selected,
      isAllSelected: selected.length === allTables.length,
    });
  };

  const toggleAll = () => {
    if (!display || !onAuditTableDisplayChange) return;
    if (display.isAllSelected) {
      onAuditTableDisplayChange({ ...display, selectedTables: [], isAllSelected: false });
    } else {
      onAuditTableDisplayChange({
        ...display,
        selectedTables: allTables.map((t) => t._id),
        isAllSelected: true,
      });
    }
  };

  return (
    <div
      className={`bg-white ${
        isShowSettings ? stylesPSettings.settings : stylesPSettings.settings_hide
      }`}
      style={{ overflow: 'auto', position: 'relative', flexShrink: '0' }}>
      <div className="pt-0 pb-5 pl-5 pr-5">
        <div
          className={`d-flex align-items-center justify-content-between ${stylesPSettings.settings_header} sticky-top bg-white pt-5`}>
          <div>
            <h4>{intl.get('settings_headline').d(`${d.settings_headline}`)}</h4>
          </div>
          <button
            className={stylesPresets.presets_uncollapse_btn2_settings}
            onClick={onToggleSettings}>
            <HiOutlineChevronDoubleRight />
          </button>
        </div>
        <div>
          {/* Account token — shared by assets & performance audits */}
          {needsToken && onSaveAccountToken && (
            <div style={{ marginTop: 16 }}>
              <AccountTokenField accountToken={accountToken || ''} onSave={onSaveAccountToken} />
            </div>
          )}

          {/* Assets audit extra settings */}
          {isAssetsAudit && (
            <div>
              <div className="mt-3 mb-2 d-flex align-items-center justify-content-between">
                <p style={{ margin: 0 }}>
                  {intl.get('settings.verify_urls').d('Verify external URLs')}
                </p>
                <button
                  onClick={() => onVerifyUrlsChange && onVerifyUrlsChange(!verifyUrls)}
                  className={
                    verifyUrls
                      ? stylesPSettings.settings_fields_toggle_btns_active
                      : stylesPSettings.settings_fields_toggle_btns
                  }
                />
              </div>
              <p style={{ fontSize: 11, color: '#999', margin: '0 0 8px' }}>
                {intl
                  .get('settings.verify_urls_desc')
                  .d(
                    'When enabled, external URLs are checked via HEAD requests during the audit. This can significantly increase audit time.'
                  )}
              </p>
            </div>
          )}

          {/* Links audit settings */}
          {isLinksAudit && (
            <div style={{ marginTop: 16 }}>
              <div className="mb-2 d-flex align-items-center justify-content-between">
                <p style={{ margin: 0 }}>
                  {intl.get('settings.auto_rerun').d('Rerun audit on preset change')}
                </p>
                <button
                  onClick={() => onAutoRerunChange && onAutoRerunChange(!autoRerun)}
                  className={
                    autoRerun
                      ? stylesPSettings.settings_fields_toggle_btns_active
                      : stylesPSettings.settings_fields_toggle_btns
                  }
                />
              </div>
            </div>
          )}

          {/* Tables audit settings. The autoRerun toggle applies to the fast
              structural audit only; the on-demand performance analysis always
              requires a manual trigger. */}
          {isTablesAudit && display && (
            <div style={{ marginTop: 8 }}>
              {/* Auto rerun toggle */}
              <div className="mb-2 d-flex align-items-center justify-content-between">
                <p style={{ margin: 0 }}>
                  {intl.get('settings.auto_rerun').d('Rerun audit on preset change')}
                </p>
                <button
                  onClick={() => onAutoRerunChange && onAutoRerunChange(!autoRerun)}
                  className={
                    autoRerun
                      ? stylesPSettings.settings_fields_toggle_btns_active
                      : stylesPSettings.settings_fields_toggle_btns
                  }
                />
              </div>

              {/* Row archival threshold — rows with _ctime AND _mtime older than this
                  many days are flagged as candidates in the Rows section. */}
              <div className="mb-2">
                <p style={{ margin: '0 0 4px 0', color: '#808080', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <PerfIcon size={12} />
                  {intl.get('settings.row_archival_threshold').d('Row archival threshold (days)')}
                </p>
                <label
                  style={{
                    fontSize: 12,
                    color: '#333',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                  }}>
                  {intl.get('settings.row_archival_label').d('Older than')}
                  <input
                    type="number"
                    min={1}
                    value={display.rowArchivalThresholdDays ?? 730}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (!onAuditTableDisplayChange || Number.isNaN(v) || v <= 0) return;
                      onAuditTableDisplayChange({
                        ...display,
                        rowArchivalThresholdDays: v,
                      });
                    }}
                    style={{
                      width: 80,
                      padding: '2px 4px',
                      fontSize: 12,
                      border: '1px solid #ccc',
                      borderRadius: 3,
                    }}
                  />
                  {intl.get('settings.row_archival_unit').d('days')}
                </label>
                {rowArchivalStale && (
                  <div
                    onClick={perfRunning ? undefined : triggerPerfRerun}
                    style={{
                      marginTop: 6,
                      fontSize: 11,
                      color: perfRunning ? '#999' : '#ff8000',
                      cursor: perfRunning ? 'default' : 'pointer',
                      textDecoration: 'underline',
                      userSelect: 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                    title={
                      perfRunning
                        ? intl
                            .get('settings.row_archival_stale_running')
                            .d('Performance analysis is running…')
                        : intl
                            .get('settings.row_archival_stale_tooltip')
                            .d('Click to rerun — or use the button above the Tables audit.')
                    }>
                    <PerfIcon size={11} color={perfRunning ? '#999' : '#ff8000'} />
                    {intl
                      .get('settings.row_archival_stale')
                      .d('Threshold changed — rerun performance analysis')}
                  </div>
                )}
              </div>

              {/* Tables to audit header + Select all */}
              <div className="mb-2 d-flex align-items-center justify-content-between">
                <p style={{ margin: 0, color: '#808080' }}>
                  {intl.get('settings.tables_to_audit').d('Tables to audit')}
                </p>
                <button
                  onClick={toggleAll}
                  className={stylesPSettings.settings_fields_show_all_btn}>
                  {display.isAllSelected
                    ? intl.get('settings.unselect_all').d('Unselect all')
                    : intl.get('settings.select_all').d('Select all')}
                </button>
              </div>

              {/* Table list — single row per table: name + selection toggle */}
              {allTables.map((table) => {
                const isSelected = display.selectedTables.includes(table._id);
                return (
                  <div
                    key={table._id}
                    className={stylesPSettings.settings_fields_columns}
                    style={{ padding: '3px' }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        width: '100%',
                        gap: 4,
                      }}>
                      <p className="ml-1 mb-0" style={{ flex: 1 }}>
                        {table.name}
                      </p>
                      <button
                        onClick={() => toggleTable(table._id)}
                        className={
                          isSelected
                            ? stylesPSettings.settings_fields_toggle_btns_active
                            : stylesPSettings.settings_fields_toggle_btns
                        }
                        style={{ marginLeft: 'auto' }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PluginSettings;
