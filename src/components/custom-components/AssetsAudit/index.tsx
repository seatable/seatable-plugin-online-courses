import React, { useState, useEffect, useRef, useCallback } from 'react';
import intl from 'react-intl-universal';
import { AssetsAuditResult, AuditStatus } from '../../../utils/custom-interfaces/AuditTypes';
import { getAuthContext } from '../../../utils/custom-utils/authHelper';
import { runAssetsAudit } from '../../../utils/custom-utils/assetsAuditRunner';
import SummaryCards from './SummaryCards';
import StorageChart from './StorageChart';
import OrphanTree from './OrphanTree';
import MissingRefs from './MissingRefs';
import ExternalUrls from './ExternalUrls';

const CollapsibleSection: React.FC<{
  title: string;
  defaultOpen?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, defaultOpen = true, actions, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 0',
        }}>
        <div
          onClick={() => setOpen(!open)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            userSelect: 'none',
            fontSize: 16,
            fontWeight: 600,
            color: '#333',
          }}>
          <i
            className={`dtable-font ${open ? 'dtable-icon-down' : 'dtable-icon-right'}`}
            style={{ fontSize: 12 }}
          />
          {title}
        </div>
        {actions && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            {actions}
          </div>
        )}
      </div>
      {open && children}
    </div>
  );
};

// Saved-audit shape, shared between props and the in-memory cache.
// `deletedPaths` is the user-driven UI state from OrphanTree, lifted here so
// it survives preset switches and is persisted alongside the audit result.
type SavedAssetsAudit = {
  result: AssetsAuditResult;
  date: string;
  deletedPaths?: string[];
};

// Module-level cache to survive preset switches
const resultCache: Record<string, SavedAssetsAudit> = {};

interface AssetsAuditProps {
  accountToken: string;
  presetId: string;
  rerunAt?: number;
  verifyUrls?: boolean;
  savedAudit?: SavedAssetsAudit | null;
  onSaveAudit?: (data: SavedAssetsAudit) => void;
}

const AssetsAudit: React.FC<AssetsAuditProps> = ({
  accountToken,
  presetId,
  rerunAt,
  verifyUrls,
  savedAudit,
  onSaveAudit,
}) => {
  const cached = resultCache[presetId] || savedAudit;
  const [result, setResult] = useState<AssetsAuditResult | null>(cached?.result || null);
  const [auditDate, setAuditDate] = useState<string>(cached?.date || '');
  const [status, setStatus] = useState<AuditStatus>(cached ? 'done' : 'idle');
  const [progressMsg, setProgressMsg] = useState('');
  // Strikethrough state for OrphanTree, lifted here so it survives preset
  // switches. Persisted alongside the audit result; reset only when a new
  // audit run completes (see runAudit), not on preset re-entry.
  const [deletedPaths, setDeletedPaths] = useState<Set<string>>(
    () => new Set(cached?.deletedPaths || [])
  );
  const lastRerunAt = useRef<number | undefined>(rerunAt);
  const hasAutoRun = useRef(!!cached);

  const runAudit = async () => {
    if (!accountToken) {
      setProgressMsg(
        intl
          .get('assets.error_no_token')
          .d('Error: No account token configured. Please add it in Settings.')
      );
      setStatus('error');
      return;
    }

    setStatus('running');
    setProgressMsg(intl.get('assets.initializing').d('Initializing...'));

    try {
      const auth = await getAuthContext();
      const auditResult = await runAssetsAudit(
        auth.serverUrl,
        auth.dtableUuid,
        accountToken,
        (msg) => setProgressMsg(msg),
        verifyUrls
      );
      const d = new Date();
      const now =
        d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
      // Fresh audit run → strikethroughs from a previous run no longer apply
      // (the new orphans list reflects current server state). Clear them in
      // both memory and the persisted payload.
      const auditData: SavedAssetsAudit = { result: auditResult, date: now, deletedPaths: [] };
      resultCache[presetId] = auditData;
      if (onSaveAudit) onSaveAudit(auditData);
      setResult(auditResult);
      setAuditDate(now);
      setDeletedPaths(new Set());
      setStatus('done');
    } catch (err: any) {
      console.error('Assets audit error:', err);
      setProgressMsg(`Error: ${err.message}`);
      setStatus('error');
    }
  };

  const handleUrlChecksUpdate = useCallback(
    (
      checks: Record<string, import('../../../utils/custom-interfaces/AuditTypes').UrlCheckResult>
    ) => {
      setResult((prev) => {
        if (!prev) return prev;
        const updated = { ...prev, urlChecks: checks };
        // Update cache too
        const cached = resultCache[presetId];
        if (cached) {
          cached.result = updated;
          if (onSaveAudit)
            onSaveAudit({ result: updated, date: cached.date, deletedPaths: cached.deletedPaths });
        }
        return updated;
      });
    },
    [presetId, onSaveAudit]
  );

  const handleMarkDeleted = useCallback(
    (paths: string[]) => {
      setDeletedPaths((prev) => {
        const next = new Set(prev);
        paths.forEach((p) => next.add(p));
        // Persist alongside the cached result so a preset switch + re-entry
        // restores the strikethroughs.
        const cached = resultCache[presetId];
        if (cached) {
          cached.deletedPaths = Array.from(next);
          if (onSaveAudit)
            onSaveAudit({
              result: cached.result,
              date: cached.date,
              deletedPaths: cached.deletedPaths,
            });
        }
        return next;
      });
    },
    [presetId, onSaveAudit]
  );

  // Auto-run on first mount if no cached result
  useEffect(() => {
    if (!hasAutoRun.current && accountToken) {
      hasAutoRun.current = true;
      runAudit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountToken]);

  // Rerun when rerunAt changes (triggered by "Rerun audit" menu)
  useEffect(() => {
    if (rerunAt && rerunAt !== lastRerunAt.current) {
      lastRerunAt.current = rerunAt;
      delete resultCache[presetId];
      runAudit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerunAt]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        .asset-audit-row:hover { background-color: #eef6fb !important; border-radius: 4px; }
        .asset-audit-group:hover { background-color: #f5f8fa !important; }
      `}</style>
      {/* Keyframes for the audit spinner AND the delete spinner inside
        OrphanTree. Must stay outside any status-conditional block: the delete
        spinner runs after the audit finishes (status === 'done'), so a
        conditionally-mounted <style> would unmount the keyframes and freeze
        the spinner on disk. */}
      <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
      {auditDate && (
        <div style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>
          {intl.get('assets.last_audit', { date: auditDate }).d('Last audit: {date}')}
        </div>
      )}

      {status === 'running' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div
            style={{
              width: 18,
              height: 18,
              border: '2px solid #ff8000',
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }}
          />
          <span style={{ fontSize: 13, color: '#666' }}>{progressMsg}</span>
        </div>
      )}

      {status === 'idle' && !accountToken && (
        <div
          style={{
            color: '#856404',
            padding: '12px 16px',
            backgroundColor: '#fff3cd',
            borderRadius: 4,
            marginBottom: 16,
          }}>
          {intl
            .get('assets.configure_token')
            .d('Please configure your account token in Settings to run the assets audit.')}
        </div>
      )}

      {status === 'error' && (
        <div
          style={{
            color: '#dc3545',
            padding: '12px 16px',
            backgroundColor: '#fff5f5',
            borderRadius: 4,
            marginBottom: 16,
          }}>
          {progressMsg}
        </div>
      )}

      {result && (
        <div style={{ flex: 1, overflow: 'auto', paddingRight: 16 }}>
          <SummaryCards result={result} />
          <CollapsibleSection
            title={intl.get('assets.storage_by_folder').d('Storage by folder')}
            defaultOpen>
            <StorageChart allFiles={result.allFiles} />
          </CollapsibleSection>
          <OrphanTree
            orphans={result.orphans}
            allFiles={result.allFiles}
            accountToken={accountToken}
            onRefresh={runAudit}
            deletedPaths={deletedPaths}
            onMarkDeleted={handleMarkDeleted}
          />
          <MissingRefs
            missingRefs={result.missingRefs}
            refSources={result.refSources}
            refDisplayNames={result.refDisplayNames}
            onRefresh={runAudit}
          />
          <ExternalUrls
            externalUrls={result.externalUrls}
            urlChecks={result.urlChecks}
            onRefresh={runAudit}
            onUrlChecksUpdate={handleUrlChecksUpdate}
          />
        </div>
      )}
    </div>
  );
};

export default AssetsAudit;
