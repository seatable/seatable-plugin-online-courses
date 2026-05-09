import React, { useState, useEffect, useRef, useCallback } from 'react';
import intl from 'react-intl-universal';
import {
  LinksAuditResult,
  LookupSuggestion,
  AuditStatus,
} from '../../../utils/custom-interfaces/AuditTypes';
import { runLinksAudit } from '../../../utils/custom-utils/linksAuditRunner';
import { getAuthContext } from '../../../utils/custom-utils/authHelper';
import TableGroup from './TableGroup';
import ContextMenu from '../shared/ContextMenu';
import { showToast } from '../shared/showToast';

interface LinksAuditProps {
  presetId: string;
  rerunAt?: number;
  autoRerun?: boolean;
  savedAudit?: { result: LinksAuditResult; date: string; lookupsChecked: boolean } | null;
  onSaveAudit?: (data: { result: LinksAuditResult; date: string; lookupsChecked: boolean }) => void;
}

async function convertToLookup(suggestion: LookupSuggestion): Promise<boolean> {
  try {
    const { serverUrl, dtableUuid, accessToken } = await getAuthContext();

    if (!serverUrl || !dtableUuid || !accessToken) return false;

    const resp = await fetch(`${serverUrl}/api-gateway/api/v2/dtables/${dtableUuid}/columns/`, {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        op_type: 'modify_column_type',
        table_name: suggestion.tableName,
        column: suggestion.columnKey,
        new_column_type: 'link-formula',
        column_data: {
          formula: 'lookup',
          operated_columns: `['${suggestion.linkColumnKey}']`,
          link_column_key: suggestion.linkColumnKey,
          level1_linked_table_column_key: suggestion.targetColumnKey,
        },
      }),
    });
    return resp.ok;
  } catch (err) {
    console.error('Failed to convert column to lookup:', err);
    return false;
  }
}

// Module-level cache to survive preset switches
const linksResultCache: Record<
  string,
  { result: LinksAuditResult; date: string; lookupsChecked: boolean }
> = {};

function formatNow(): string {
  const d = new Date();
  return (
    d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  );
}

const LinksAudit: React.FC<LinksAuditProps> = ({
  presetId,
  rerunAt,
  autoRerun,
  savedAudit,
  onSaveAudit,
}) => {
  const cached = linksResultCache[presetId] || savedAudit;
  const [result, setResult] = useState<LinksAuditResult | null>(cached?.result || null);
  const [status, setStatus] = useState<AuditStatus>(cached ? 'done' : 'idle');
  const [progressMsg, setProgressMsg] = useState('');
  const [sectionOpen, setSectionOpen] = useState(true);
  const [allExpanded, setAllExpanded] = useState(true);
  const [expandKey, setExpandKey] = useState(0);
  const [lookupsChecked, setLookupsChecked] = useState(cached?.lookupsChecked || false);
  const [auditDate, setAuditDate] = useState<string>(cached?.date || '');
  const hasAutoRun = useRef(!!cached);
  const lastRerunAt = useRef<number | undefined>(rerunAt);

  const doAudit = useCallback(
    (silent = false, withLookups = false) => {
      if (!silent) {
        setStatus('running');
        setProgressMsg(
          withLookups
            ? intl.get('links.checking_lookups').d('Checking for lookup suggestions...')
            : intl.get('links.scanning').d('Scanning link columns...')
        );
      }

      setTimeout(
        async () => {
          try {
            const auditResult = await runLinksAudit(withLookups, (msg) => {
              if (!silent) setProgressMsg(msg);
            });
            const now = formatNow();
            const didLookups = withLookups || lookupsChecked;
            const auditData = { result: auditResult, date: now, lookupsChecked: didLookups };
            linksResultCache[presetId] = auditData;
            if (onSaveAudit) onSaveAudit(auditData);
            setResult(auditResult);
            setAuditDate(now);
            if (withLookups) setLookupsChecked(true);
            setStatus('done');
          } catch (err: any) {
            if (!silent) {
              setProgressMsg(`Error: ${err.message}`);
              setStatus('error');
            }
          }
        },
        silent ? 0 : 50
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [presetId]
  );

  const debouncedRefresh = useCallback(() => {
    delete linksResultCache[presetId];
    doAudit();
  }, [doAudit, presetId]);

  // Auto-run on first mount if no cached result, or always if autoRerun is enabled
  useEffect(() => {
    if (!hasAutoRun.current || autoRerun) {
      hasAutoRun.current = true;
      doAudit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rerun when rerunAt changes (triggered by "Rerun audit" menu)
  useEffect(() => {
    if (rerunAt && rerunAt !== lastRerunAt.current) {
      lastRerunAt.current = rerunAt;
      delete linksResultCache[presetId];
      doAudit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerunAt]);

  // Group data by table
  const tableNames = result
    ? Array.from(
        new Set(
          result.linkColumns
            .map((lc) => lc.tableName)
            .concat(result.linkFormulas.map((lf) => lf.tableName))
        )
      )
    : [];

  const totalIssues = result
    ? result.unusedLinks.length + result.redundantLinks.length + result.missingMirrors.length
    : 0;

  const toggleAll = () => {
    setAllExpanded(!allExpanded);
    setExpandKey((k) => k + 1);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>

      {auditDate && (
        <div style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>
          {intl.get('links.last_audit', { date: auditDate }).d(`Last audit: ${auditDate}`)}
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

      {status === 'done' &&
        result &&
        (result.linkColumns.length > 0 || result.linkFormulas.length > 0) && (
          <div style={{ flex: 1, overflow: 'auto', paddingRight: 16 }}>
            {/* Summary */}
            <div style={{ marginBottom: 24, fontSize: 14, lineHeight: 1.8 }}>
              <table style={{ borderCollapse: 'collapse' }}>
                <tbody>
                  <tr>
                    <td style={{ fontWeight: 600, paddingRight: 12, color: '#333' }}>
                      {intl.get('links.link_columns').d('Link columns')}
                    </td>
                    <td style={{ fontWeight: 600, paddingRight: 8, textAlign: 'right' }}>
                      {result.linkColumns.length}
                    </td>
                    <td style={{ color: '#888' }}>
                      {intl
                        .get('links.across_tables', { count: tableNames.length })
                        .d('across {count} table(s)')}
                    </td>
                  </tr>
                  <tr>
                    <td style={{ paddingRight: 12, color: '#333' }}>
                      {intl.get('links.link_formula_columns').d('Link-formula columns')}
                    </td>
                    <td style={{ paddingRight: 8, textAlign: 'right' }}>
                      {result.linkFormulas.length}
                    </td>
                    <td style={{ color: '#888' }}>
                      {intl.get('links.link_formula_desc').d('(lookup, rollup, count, etc.)')}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={3} style={{ height: 8 }}></td>
                  </tr>
                  <tr>
                    <td
                      style={{
                        paddingRight: 12,
                        color: totalIssues > 0 ? '#e6a117' : '#28a745',
                      }}>
                      {intl.get('links.issues_detected').d('Issues detected')}
                    </td>
                    <td
                      style={{
                        paddingRight: 8,
                        textAlign: 'right',
                        color: totalIssues > 0 ? '#e6a117' : '#28a745',
                      }}>
                      {totalIssues}
                    </td>
                    <td style={{ color: '#888', fontSize: 13 }}>
                      {result.unusedLinks.length > 0 && (
                        <span>
                          {result.unusedLinks.length} {intl.get('links.unused').d('unused')}
                        </span>
                      )}
                      {result.unusedLinks.length > 0 &&
                        (result.redundantLinks.length > 0 || result.missingMirrors.length > 0) &&
                        ' · '}
                      {result.redundantLinks.length > 0 && (
                        <span>
                          {result.redundantLinks.length}{' '}
                          {intl.get('links.redundant').d('redundant')}
                        </span>
                      )}
                      {result.redundantLinks.length > 0 &&
                        result.missingMirrors.length > 0 &&
                        ' · '}
                      {result.missingMirrors.length > 0 && (
                        <span>
                          {result.missingMirrors.length}{' '}
                          {intl.get('links.no_mirror').d('no mirror')}
                        </span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Links section header. The count parenthesis ({N}) was dropped
              — it summed link columns + link-formula columns, which read like
              one number but mixed two kinds of items. The collapse stays
              because there's a sibling "Lookup suggestions" section below. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0' }}>
              <div
                onClick={() => setSectionOpen(!sectionOpen)}
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
                  className={`dtable-font ${sectionOpen ? 'dtable-icon-down' : 'dtable-icon-right'}`}
                  style={{ fontSize: 12 }}
                />
                {intl.get('links.links_section_title').d('Links')}
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  onClick={toggleAll}
                  style={{ fontSize: 12, color: '#ff8000', cursor: 'pointer', userSelect: 'none' }}>
                  {allExpanded
                    ? intl.get('common.collapse_all').d('Collapse all')
                    : intl.get('common.expand_all').d('Expand all')}
                </span>
              </div>
            </div>

            {sectionOpen && (
              <div style={{ fontSize: 14 }}>
                {tableNames.map((name) => (
                  <TableGroup
                    key={`${name}-${expandKey}`}
                    tableName={name}
                    linkColumns={result.linkColumns.filter((lc) => lc.tableName === name)}
                    linkFormulas={result.linkFormulas.filter((lf) => lf.tableName === name)}
                    redundantLinks={result.redundantLinks}
                    defaultOpen={allExpanded}
                    defaultExpandAll={allExpanded}
                    onRefresh={debouncedRefresh}
                  />
                ))}
              </div>
            )}

            {/* Lookup suggestions section */}
            <div style={{ marginTop: 16 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 0',
                  fontSize: 16,
                  fontWeight: 600,
                  color: '#333',
                }}>
                {intl.get('links.lookup_suggestions').d('Lookup suggestions')}
                {lookupsChecked && (
                  <span style={{ fontSize: 13, fontWeight: 400, color: '#888' }}>
                    ({result.lookupSuggestions.length})
                  </span>
                )}
              </div>

              {!lookupsChecked && (
                <div style={{ padding: '4px 8px', fontSize: 13 }}>
                  <span
                    onClick={() => doAudit(false, true)}
                    style={{ color: '#ff8000', cursor: 'pointer', userSelect: 'none' }}>
                    {intl.get('links.check_lookups').d('Check for lookup suggestions')}
                  </span>
                  <span style={{ color: '#888', marginLeft: 8 }}>
                    {intl
                      .get('links.check_lookups_desc')
                      .d(
                        '— compares manual columns against linked records to detect potential lookups'
                      )}
                  </span>
                </div>
              )}

              {lookupsChecked && result.lookupSuggestions.length === 0 && (
                <div style={{ padding: '4px 8px', fontSize: 13, color: '#28a745' }}>
                  {intl
                    .get('links.no_suggestions')
                    .d('No suggestions — all manual columns contain unique data')}
                </div>
              )}

              {lookupsChecked && result.lookupSuggestions.length > 0 && (
                <div style={{ fontSize: 13 }}>
                  {result.lookupSuggestions.map((s, i) => (
                    <div
                      key={i}
                      className="asset-audit-row"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 8px',
                        paddingLeft: 16,
                      }}>
                      <span style={{ fontWeight: 500 }}>{s.tableName}</span>
                      <span style={{ color: '#999' }}>.</span>
                      <span>{s.columnName}</span>
                      <span style={{ color: '#888', fontSize: 12 }}>{s.columnType}</span>
                      <span style={{ color: '#999' }}>
                        → {intl.get('common.could_be').d('could be')}
                      </span>
                      <span style={{ color: '#ff8000' }}>
                        lookup(<span style={{ fontWeight: 600 }}>{s.targetTableName}</span> /{' '}
                        {s.targetColumnName})
                      </span>
                      <span style={{ color: '#888', fontSize: 12 }}>
                        {intl.get('common.via').d('via')} {s.linkColumnName}
                      </span>
                      <span style={{ marginLeft: 'auto' }}>
                        <ContextMenu
                          onDelete={() => {
                            convertToLookup(s).then((ok) => {
                              if (ok) {
                                showToast(
                                  `Converted "${s.columnName}" to lookup(${s.targetTableName} / ${s.targetColumnName})`
                                );
                                doAudit(false, true);
                              } else {
                                showToast(`Failed to convert "${s.columnName}"`);
                              }
                            });
                          }}
                          label={intl.get('links.replace_with_lookup').d('Replace with lookup')}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

      {status === 'done' &&
        result &&
        result.linkColumns.length === 0 &&
        result.linkFormulas.length === 0 && (
          <div style={{ color: '#888', padding: 20 }}>
            {intl.get('links.no_links_found').d('No link columns found in this base.')}
          </div>
        )}

      {status === 'error' && <div style={{ color: '#dc3545', padding: 20 }}>{progressMsg}</div>}
    </div>
  );
};

export default LinksAudit;
