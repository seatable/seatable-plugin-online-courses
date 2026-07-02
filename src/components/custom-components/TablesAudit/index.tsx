import React, { useState, useEffect, useRef, useCallback } from 'react';
import intl from 'react-intl-universal';
import {
  TableAuditResult,
  AuditStatus,
  AuditTableDisplayState,
  PerformanceAuditResult,
  RemediationAction,
  RemediatedView,
} from '../../../utils/custom-interfaces/AuditTypes';
import { auditAllTables } from '../../../utils/custom-utils/tableAuditor';
import { formatNow } from '../../../utils/custom-utils/formatters';
import TableTab from './TableTab';
import PerformanceAudit, {
  PerformanceAuditHandle,
  SavedPerformanceAudit,
} from '../PerformanceAudit';
import PerfIcon from '../shared/PerfIcon';

interface TablesAuditProps {
  presetId: string;
  rerunAt?: number;
  auditTableDisplay?: AuditTableDisplayState;
  autoRerun?: boolean;
  savedAudit?: { results: TableAuditResult[]; date: string } | null;
  onSaveAudit?: (data: { results: TableAuditResult[]; date: string }) => void;
  // Props forwarded to the embedded PerformanceAudit section at the bottom of the
  // Tables audit. Kept separate from Tables audit's own save/cache state — the fast
  // structural audit and the on-demand performance analysis persist independently.
  accountToken?: string;
  savedPerformanceAudit?: SavedPerformanceAudit | null;
  onSavePerformanceAudit?: (data: SavedPerformanceAudit) => void;
  // Lifted up to App so PluginSettings can disable the staleness-rerun link
  // while a performance analysis is in progress.
  onPerfRunningChange?: (running: boolean) => void;
}

// Module-level cache to survive preset switches
const resultCache: Record<string, { results: TableAuditResult[]; date: string }> = {};

const TablesAudit: React.FC<TablesAuditProps> = ({
  presetId,
  rerunAt,
  auditTableDisplay,
  autoRerun,
  savedAudit,
  onSaveAudit,
  accountToken,
  savedPerformanceAudit,
  onSavePerformanceAudit,
  onPerfRunningChange,
}) => {
  const cached = resultCache[presetId] || savedAudit;
  const [results, setResults] = useState<TableAuditResult[]>(cached?.results || []);
  const [activeTab, setActiveTab] = useState(0);
  const [status, setStatus] = useState<AuditStatus>(cached ? 'done' : 'idle');
  const [progressMsg, setProgressMsg] = useState('');
  const [auditDate, setAuditDate] = useState<string>(cached?.date || '');
  const hasAutoRun = useRef(!!cached);
  const activeTabNameRef = useRef<string>('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const auditDisplayRef = useRef(auditTableDisplay);
  auditDisplayRef.current = auditTableDisplay;
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [tabBarWidth, setTabBarWidth] = useState<number | undefined>(undefined);

  // Performance analysis state — lifted from the embedded PerformanceAudit via a ref
  // + onResultChange callback so we can render its result in per-table tabs too.
  const perfAuditRef = useRef<PerformanceAuditHandle | null>(null);
  const [perfResult, setPerfResult] = useState<PerformanceAuditResult | null>(null);
  const [perfAuditDate, setPerfAuditDate] = useState<string>('');
  const [perfStatus, setPerfStatus] = useState<AuditStatus>('idle');
  // True while a single-column freeze-now or unfreeze is running. Separate from
  // perfStatus (audit run) so the two can coexist (rare but plausible) and so
  // we can render the header spinner without faking perfStatus = 'running'.
  const [perfBusy, setPerfBusy] = useState(false);
  // Union of session pendingFrozenNow + persisted plugin-settings frozenColumns,
  // mirrored up from PerformanceAudit so per-table tabs can render the same
  // strikethrough/"frozen" treatment Overview's CandidateRow uses.
  const [perfFrozenKeys, setPerfFrozenKeys] = useState<Set<string>>(new Set());
  // Mirrored from PerformanceAudit so per-table tabs can render strikethrough on the
  // archival cell after a delete (the embedded audit is a sibling, not a child of
  // TableTab, so this state has to round-trip up).
  const [perfDeletedArchivalIds, setPerfDeletedArchivalIds] = useState<Set<string>>(new Set());
  // Mirrored from PerformanceAudit so the header can show the live progress message
  // during a run, regardless of which tab is active.
  const [perfProgressMsg, setPerfProgressMsg] = useState('');
  // Mirrored staged remediation maps so per-table tabs can render Stage/Unstage
  // labels reactively in their three-dots menus.
  const [stagedColumns, setStagedColumns] = useState<Map<string, RemediationAction>>(new Map());
  const [stagedViews, setStagedViews] = useState<Map<string, RemediatedView>>(new Map());

  // Mirror running-state up to the App so PluginSettings can disable the
  // "Threshold changed — rerun performance analysis" link while a run is in flight.
  useEffect(() => {
    if (onPerfRunningChange) onPerfRunningChange(perfStatus === 'running');
  }, [perfStatus, onPerfRunningChange]);

  // Listen for the "Run performance analysis" entry in this preset's dropdown
  // (PresetItem dispatches the event with the active preset id). Decoupled
  // wiring so PluginPresets / PresetItem don't need to know about TablesAudit.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.presetId && detail.presetId === presetId) {
        if (perfStatus === 'running' || perfBusy) return;
        setActiveTab(0);
        perfAuditRef.current?.run();
      }
    };
    window.addEventListener('audit:run-perf', handler);
    return () => window.removeEventListener('audit:run-perf', handler);
  }, [presetId, perfStatus, perfBusy]);

  // Track the active tab by name so we can restore it after refresh. activeTab === 0
  // is the Overview tab; table tabs start at 1, so we offset by -1 to index `results`.
  useEffect(() => {
    if (activeTab > 0 && results[activeTab - 1]) {
      activeTabNameRef.current = results[activeTab - 1].tableName;
    } else if (activeTab === 0) {
      activeTabNameRef.current = '';
    }
  }, [activeTab, results]);

  // Measure actual container width via ResizeObserver
  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      setCanScrollLeft(el.scrollLeft > 0);
      setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      setTabBarWidth(container.clientWidth);
      updateScrollState();
    });
    observer.observe(container);

    // Initial measurement
    setTabBarWidth(container.clientWidth);
    const timer = setTimeout(updateScrollState, 50);

    const el = scrollRef.current;
    if (el) el.addEventListener('scroll', updateScrollState);

    // Convert vertical wheel to horizontal scroll on the tab bar
    const handleWheel = (e: WheelEvent) => {
      if (!el || e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    if (el) el.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      observer.disconnect();
      clearTimeout(timer);
      if (el) {
        el.removeEventListener('scroll', updateScrollState);
        el.removeEventListener('wheel', handleWheel);
      }
    };
  }, [results, updateScrollState]);

  const scroll = (dir: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -150 : 150, behavior: 'smooth' });
  };

  const runAudit = useCallback(
    (
      silent = false,
      // When provided, tables-audit progress messages route through this
      // callback INSTEAD of TablesAudit's own setProgressMsg. Used by the
      // chained perf-audit flow so progress shows in the perf-audit spinner
      // (single visible spinner during the chain) rather than triggering
      // TablesAudit's own status='running' UI — which would unmount the
      // embedded PerformanceAudit mid-chain and break the chained run.
      progressOverride?: (msg: string) => void
    ): Promise<void> => {
      const chained = !!progressOverride;
      if (!silent && !chained) {
        setStatus('running');
        setProgressMsg(intl.get('tables.starting').d('Starting tables audit...'));
      }
      const reportProgress = (msg: string) => {
        if (progressOverride) progressOverride(msg);
        else if (!silent) setProgressMsg(msg);
      };

      return new Promise<void>((resolve) => {
        setTimeout(
          async () => {
            try {
              const tableResults = await auditAllTables(
                [],
                reportProgress,
                auditDisplayRef.current
              );
              const now = formatNow();
              const auditData = { results: tableResults, date: now };
              resultCache[presetId] = auditData;
              if (onSaveAudit) onSaveAudit(auditData);
              setResults(tableResults);
              setAuditDate(now);

              const prevName = activeTabNameRef.current;
              if (prevName) {
                const idx = tableResults.findIndex((r) => r.tableName === prevName);
                if (idx !== -1) {
                  // +1 offset: Overview tab occupies index 0, table tabs start at 1.
                  setActiveTab(idx + 1);
                } else if (activeTab > tableResults.length) {
                  // Active table was removed; fall back to last available table tab
                  // (or Overview if there are no tables left).
                  setActiveTab(Math.max(0, tableResults.length));
                }
              }

              // In chained mode, leave TablesAudit's status alone — flipping it
              // would unmount/remount the embedded PerformanceAudit and break
              // the in-flight chained run.
              if (!chained) setStatus('done');
            } catch (err: any) {
              if (chained) {
                reportProgress(`Tables audit error: ${err.message}`);
              } else if (!silent) {
                setProgressMsg(`Error: ${err.message}`);
                setStatus('error');
              }
            } finally {
              // Always resolve — callers chaining off this (e.g. perf audit
              // wanting fresh tables data first) should proceed even if the
              // tables audit failed, so a transient failure here doesn't block
              // the whole perf flow.
              resolve();
            }
          },
          silent || chained ? 0 : 50
        );
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [presetId]
  );

  // Previously called after every column/view deletion. Now TableTab marks deletions
  // visually (strikethrough) without triggering a rerun — the audit is expensive on
  // large bases (per-view getTableRows) and rerunning after each click froze the page.
  // Users trigger a real rerun via the preset context menu when they want fresh numbers.
  const debouncedRefresh = useCallback(() => {
    // Intentionally no-op.
  }, []);

  // Auto-run on first mount if no cached result, or always if autoRerun is enabled
  const lastRerunAt = useRef<number | undefined>(rerunAt);
  useEffect(() => {
    if (!hasAutoRun.current || autoRerun) {
      hasAutoRun.current = true;
      runAudit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rerun when rerunAt changes (triggered by "Rerun audit" menu)
  useEffect(() => {
    if (rerunAt && rerunAt !== lastRerunAt.current) {
      lastRerunAt.current = rerunAt;
      delete resultCache[presetId];
      runAudit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerunAt]);

  // Re-run Tables audit ONLY when fields that affect the structural audit change.
  // Performance-only fields (view-size thresholds, row archival threshold, perfRerunAt)
  // are intentionally excluded — they affect the on-demand Performance analysis,
  // not the fast Tables audit.
  const tablesAuditRelevant = (d?: AuditTableDisplayState) =>
    JSON.stringify({
      selectedTables: d?.selectedTables,
      isAllSelected: d?.isAllSelected,
    });
  const displayRef = useRef(tablesAuditRelevant(auditTableDisplay));
  useEffect(() => {
    const newHash = tablesAuditRelevant(auditTableDisplay);
    if (newHash !== displayRef.current) {
      displayRef.current = newHash;
      delete resultCache[presetId];
      runAudit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditTableDisplay]);

  // Watch perfRerunAt — when PluginSettings bumps this timestamp (user clicked the
  // staleness notification), trigger a performance rerun and jump to Overview tab.
  const lastPerfRerunAt = useRef(auditTableDisplay?.perfRerunAt);
  useEffect(() => {
    const v = auditTableDisplay?.perfRerunAt;
    if (v && v !== lastPerfRerunAt.current) {
      lastPerfRerunAt.current = v;
      setActiveTab(0);
      perfAuditRef.current?.run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditTableDisplay?.perfRerunAt]);

  return (
    <div
      ref={containerRef}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`
        .audit-tables-tabs {
          display: flex;
          align-items: stretch;
          background: #f5f5f5;
          margin-bottom: 0;
          height: 40px;
          min-height: 40px;
          max-height: 40px;
          overflow: hidden;
        }
        .audit-tabs-scroll {
          overflow-x: auto;
          overflow-y: hidden;
          flex: 1 1 0px;
          min-width: 0;
          display: flex;
          align-items: stretch;
          scrollbar-width: none;
        }
        .audit-tabs-scroll::-webkit-scrollbar {
          display: none;
        }
        .audit-tabs-inner {
          display: flex;
          white-space: nowrap;
          align-items: stretch;
        }
        .audit-tab {
          display: flex;
          align-items: center;
          padding: 0 16px;
          font-size: 13px;
          color: #666;
          cursor: pointer;
          border: none;
          background: transparent;
          user-select: none;
          transition: background 0.15s, color 0.15s;
          flex-shrink: 0;
        }
        .audit-tab:hover {
          color: #333;
          background: rgba(255,255,255,0.6);
        }
        .audit-tab-active {
          background: #fff !important;
          color: #333 !important;
          font-weight: 500;
        }
        .audit-scroll-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          min-width: 28px;
          cursor: pointer;
          color: #666;
          flex-shrink: 0;
          user-select: none;
          background: #f5f5f5;
          z-index: 1;
        }
        .audit-scroll-btn:hover { color: #333; background: #eaeaea; }
        .audit-scroll-btn-disabled {
          color: #ccc !important;
          cursor: default;
          pointer-events: none;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      {/* Header: two lines.
          Line 1: structural audit date (Tables audit) + base-wide figures
          Line 2: performance test date + Run/Rerun button */}
      {(auditDate || perfAuditDate || status === 'done') && (
        <div style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>
          {auditDate && (
            <div>
              {intl.get('tables.last_audit', { date: auditDate }).d(`Last audit: ${auditDate}`)}
              {results.length > 0 &&
                (() => {
                  const totalTables = results.length;
                  const totalRows = results.reduce((s, t) => s + (t.rowCount || 0), 0);
                  const totalColumns = results.reduce((s, t) => s + (t.columnCount || 0), 0);
                  const totalViews = results.reduce((s, t) => s + (t.viewCount || 0), 0);
                  return (
                    <>
                      <span style={{ color: '#bbb', margin: '0 8px' }}>·</span>
                      {intl
                        .get('tables.figures_tables', { count: totalTables })
                        .d(`${totalTables} tables`)}
                      <span style={{ color: '#bbb', margin: '0 8px' }}>·</span>
                      {intl.get('tables.figures_rows', { count: totalRows }).d(`${totalRows} rows`)}
                      <span style={{ color: '#bbb', margin: '0 8px' }}>·</span>
                      {intl
                        .get('tables.figures_columns', { count: totalColumns })
                        .d(`${totalColumns} columns`)}
                      <span style={{ color: '#bbb', margin: '0 8px' }}>·</span>
                      {intl
                        .get('tables.figures_views', { count: totalViews })
                        .d(`${totalViews} views`)}
                    </>
                  );
                })()}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              marginTop: auditDate ? 4 : 0,
            }}>
            {perfAuditDate && perfStatus !== 'running' && !perfBusy && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <PerfIcon size={13} />
                {intl
                  .get('tables.last_perf', { date: perfAuditDate })
                  .d(`Performance test: ${perfAuditDate}`)}
              </span>
            )}
            {!perfAuditDate && perfStatus !== 'running' && !perfBusy && (
              <span
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('audit:open-preset-menu', { detail: { presetId } })
                  )
                }
                title={intl
                  .get('tables.no_perf_yet_open_menu')
                  .d('Open the preset menu (•••) above to run the performance analysis.')}
                style={{
                  fontStyle: 'italic',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  cursor: 'pointer',
                  color: '#ff8000',
                }}>
                <PerfIcon size={13} />
                {intl.get('tables.no_perf_yet').d('Performance test: not run yet')}
              </span>
            )}
            {(perfStatus === 'running' || perfBusy) && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    width: 14,
                    height: 14,
                    border: '2px solid #ff8000',
                    borderTopColor: 'transparent',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                    display: 'inline-block',
                  }}
                />
                <span style={{ color: '#666' }}>{perfProgressMsg}</span>
              </span>
            )}
          </div>
          {/* First-run hint about what the performance analysis does. Hidden once
              the audit has produced a result — the date mention + dropdown entry
              are enough context for repeat users. */}
          {perfStatus === 'idle' && !perfAuditDate && (
            <div style={{ marginTop: 6, fontSize: 13, color: '#888' }}>
              {intl
                .get('performance.run_analysis_hint')
                .d(
                  'Benchmarks the base, measures per-column formula cost, sizes every view, and opens the test/sandbox workflow. Takes 30s or more on large bases.'
                )}
            </div>
          )}
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

      {status === 'done' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div
            className="audit-tables-tabs"
            style={tabBarWidth ? { width: tabBarWidth } : undefined}>
            <div className="audit-tabs-scroll" ref={scrollRef}>
              <div className="audit-tabs-inner">
                {/* Overview tab first — cross-table flat view of performance data.
                    activeTab === 0 is Overview; table tabs start at activeTab === 1.
                    During a perf-audit run, tabs are non-clickable: the content
                    won't update until the perf audit finishes, so switching tabs
                    would just show stale data and confuse the user. */}
                <div
                  key="__overview__"
                  className={`audit-tab ${activeTab === 0 ? 'audit-tab-active' : ''}`}
                  onClick={() => {
                    if (perfStatus !== 'running') setActiveTab(0);
                  }}
                  style={
                    perfStatus === 'running' ? { cursor: 'not-allowed', opacity: 0.5 } : undefined
                  }
                  title={intl.get('tables.performance_tab').d('Performance')}>
                  <span style={{ fontWeight: 500 }}>
                    {intl.get('tables.performance_tab').d('Performance')}
                  </span>
                </div>
                {results.map((r, i) => (
                  <div
                    key={r.tableName}
                    className={`audit-tab ${activeTab === i + 1 ? 'audit-tab-active' : ''}`}
                    onClick={() => {
                      if (perfStatus !== 'running') setActiveTab(i + 1);
                    }}
                    style={
                      perfStatus === 'running' ? { cursor: 'not-allowed', opacity: 0.5 } : undefined
                    }
                    title={r.tableName}>
                    <span>{r.tableName}</span>
                  </div>
                ))}
              </div>
            </div>
            <div
              className={`audit-scroll-btn ${!canScrollLeft ? 'audit-scroll-btn-disabled' : ''}`}
              onClick={() => scroll('left')}>
              <i className="dtable-font dtable-icon-left" style={{ fontSize: 12 }} />
            </div>
            <div
              className={`audit-scroll-btn ${!canScrollRight ? 'audit-scroll-btn-disabled' : ''}`}
              onClick={() => scroll('right')}>
              <i className="dtable-font dtable-icon-right" style={{ fontSize: 12 }} />
            </div>
          </div>

          <div
            style={{ flex: 1, overflow: 'auto', background: '#fff', padding: 16, border: 'none' }}>
            {/* Overview: always mounted so PerformanceAudit's state (tests, sandbox,
                remediations) persists when the user switches between tabs. We hide
                via display:none rather than unmount. */}
            <div style={{ display: activeTab === 0 ? 'block' : 'none' }}>
              <PerformanceAudit
                ref={perfAuditRef}
                embedded
                accountToken={accountToken || ''}
                presetId={presetId}
                rerunAt={rerunAt}
                autoRerun={false}
                savedAudit={savedPerformanceAudit}
                onSaveAudit={onSavePerformanceAudit}
                rowArchivalThresholdDays={auditTableDisplay?.rowArchivalThresholdDays}
                selectedTableIds={auditTableDisplay?.selectedTables}
                tablesAuditResults={results}
                onResultChange={(r, d) => {
                  setPerfResult(r);
                  setPerfAuditDate(d);
                }}
                onStatusChange={setPerfStatus}
                onBusyChange={setPerfBusy}
                onFrozenKeysChange={setPerfFrozenKeys}
                onDeletedArchivalTableIdsChange={setPerfDeletedArchivalIds}
                onProgressChange={setPerfProgressMsg}
                onStagedColumnsChange={setStagedColumns}
                onStagedViewsChange={setStagedViews}
                onRequestTablesAuditRerun={(onProgress) => runAudit(false, onProgress)}
              />
            </div>
            {activeTab > 0 && results[activeTab - 1] && (
              <TableTab
                key={results[activeTab - 1].tableName}
                result={results[activeTab - 1]}
                onRefresh={debouncedRefresh}
                perfResult={perfResult}
                onCreateArchivalView={(tableId) =>
                  perfAuditRef.current?.createArchivalViewForTable(tableId)
                }
                onDeleteArchivalRows={(tableId) =>
                  perfAuditRef.current?.deleteArchivalRowsForTable(tableId)
                }
                onSelectColumnForReplacement={(tableId, columnKey) => {
                  perfAuditRef.current?.selectColumnForReplacement(tableId, columnKey);
                  // Switch to Overview so the user sees the column now marked and can
                  // run the sandbox test from there.
                  setActiveTab(0);
                }}
                onToggleColumnDelete={(tableId, columnKey) => {
                  perfAuditRef.current?.toggleColumnDelete(tableId, columnKey);
                  setActiveTab(0);
                }}
                onToggleViewDelete={(payload) => {
                  perfAuditRef.current?.toggleViewDelete(payload);
                  setActiveTab(0);
                }}
                onUnstageColumn={(tableId, columnKey) =>
                  perfAuditRef.current?.unstageColumn(tableId, columnKey)
                }
                onUnstageView={(tableId, viewId) =>
                  perfAuditRef.current?.unstageView(tableId, viewId)
                }
                stagedColumns={stagedColumns}
                stagedViews={stagedViews}
                frozenKeys={perfFrozenKeys}
                deletedArchivalTableIds={perfDeletedArchivalIds}
                onRequestPerfRerun={() => perfAuditRef.current?.run()}
                perfRunning={perfStatus === 'running'}
              />
            )}
          </div>
        </div>
      )}

      {status === 'error' && <div style={{ color: '#dc3545', padding: 20 }}>{progressMsg}</div>}
    </div>
  );
};

export default TablesAudit;
