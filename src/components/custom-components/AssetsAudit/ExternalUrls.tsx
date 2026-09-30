import React, { useState } from 'react';
import intl from 'react-intl-universal';
import { RefSource, UrlCheckResult } from '../../../utils/custom-interfaces/AuditTypes';
import { FaChevronRight, FaChevronDown, FaExternalLinkAlt } from 'react-icons/fa';
import ContextMenu from '../shared/ContextMenu';
import { showToast } from '../shared/showToast';

interface ExternalUrlsProps {
  externalUrls: Record<string, RefSource[]>;
  urlChecks: Record<string, UrlCheckResult>;
  onRefresh: () => void;
  onUrlChecksUpdate?: (checks: Record<string, UrlCheckResult>) => void;
}

interface SourceGroup {
  table: string;
  column: string;
  entries: { url: string; rowId: string; key: string }[];
}

function removeExternalUrl(
  tableName: string,
  columnName: string,
  rowId: string,
  targetUrl: string
): boolean {
  try {
    const dtableSDK = (window as any).dtableSDK;
    const tables = dtableSDK.getTables();
    const table = tables.find((t: any) => t.name === tableName);
    if (!table) return false;
    const column = table.columns.find((c: any) => c.name === columnName);
    if (!column) return false;
    const row = table.rows.find((r: any) => r._id === rowId);
    if (!row) return false;

    const cellValue = row[column.key];
    if (Array.isArray(cellValue)) {
      const filtered = cellValue.filter((item: any) => {
        const url = typeof item === 'object' && item !== null ? item.url || '' : String(item);
        return url !== targetUrl;
      });
      dtableSDK.modifyRow(table, row, { [column.name]: filtered.length > 0 ? filtered : null });
    } else {
      dtableSDK.modifyRow(table, row, { [column.name]: null });
    }
    return true;
  } catch (err) {
    console.error('Failed to remove external URL:', err);
    return false;
  }
}

const STATUS_STYLES: Record<string, { color: string; label: string }> = {
  ok: { color: '#28a745', label: 'OK' },
  broken: { color: '#dc3545', label: 'Broken' },
  unverifiable: { color: '#e6a117', label: 'CORS' },
};

async function checkUrl(url: string): Promise<UrlCheckResult> {
  try {
    const resp = await fetch(url, { method: 'HEAD', mode: 'cors' });
    return resp.ok ? { result: 'ok', code: resp.status } : { result: 'broken', code: resp.status };
  } catch {
    try {
      await fetch(url, { method: 'HEAD', mode: 'no-cors' });
      return { result: 'unverifiable', error: 'CORS' };
    } catch {
      return { result: 'broken', error: 'Unreachable' };
    }
  }
}

const ExternalUrls: React.FC<ExternalUrlsProps> = ({
  externalUrls,
  urlChecks,
  onUrlChecksUpdate,
}) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sectionOpen, setSectionOpen] = useState(true);
  const [deletedKeys, setDeletedKeys] = useState<Set<string>>(new Set());
  const [verifying, setVerifying] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState('');
  const [localChecks, setLocalChecks] = useState<Record<string, UrlCheckResult>>({});

  // Merge audit checks with local manual checks (local takes precedence)
  const mergedChecks = { ...urlChecks, ...localChecks };

  const urlCount = Object.keys(externalUrls).length;
  if (urlCount === 0) {
    return (
      <div style={{ color: '#28a745', padding: '8px 0' }}>
        {intl.get('external_urls.none_found').d('No external URLs found.')}
      </div>
    );
  }

  const bySource: Record<string, { url: string; rowId: string; key: string }[]> = {};
  for (const [url, sources] of Object.entries(externalUrls)) {
    for (const source of sources) {
      const groupKey = `${source.tableName}:::${source.columnName}`;
      if (!bySource[groupKey]) bySource[groupKey] = [];
      const entryKey = `${source.tableName}:::${source.columnName}:::${source.rowId}:::${url}`;
      bySource[groupKey].push({ url, rowId: source.rowId, key: entryKey });
    }
  }

  const groups: SourceGroup[] = Object.entries(bySource)
    .map(([key, entries]) => {
      const [table, column] = key.split(':::');
      return { table, column, entries: entries.sort((a, b) => a.url.localeCompare(b.url)) };
    })
    .sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));

  const allKeys = groups.map((g) => `${g.table}:::${g.column}`);
  const allExpanded = allKeys.length > 0 && allKeys.every((k) => expanded.has(k));

  const isBroken = (url: string) => mergedChecks[url]?.result === 'broken';
  const isEntryDeleted = (key: string) => deletedKeys.has(key);
  const isGroupDeleted = (group: SourceGroup) => group.entries.every((e) => deletedKeys.has(e.key));

  const markDeleted = (keys: string[]) => {
    setDeletedKeys((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => next.add(k));
      return next;
    });
  };

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (allExpanded) {
      setExpanded(new Set());
    } else {
      setExpanded(new Set(allKeys));
    }
  };

  const handleDelete = (
    table: string,
    column: string,
    url: string,
    rowId: string,
    entryKey: string
  ) => {
    if (removeExternalUrl(table, column, rowId, url)) {
      showToast(
        intl
          .get('external_urls.removed_url', { table, column })
          .d('Removed external URL from {table}.{column}')
      );
      markDeleted([entryKey]);
    }
  };

  const handleDeleteBrokenInGroup = (group: SourceGroup) => {
    const deleted: string[] = [];
    for (const entry of group.entries) {
      if (!isEntryDeleted(entry.key) && isBroken(entry.url)) {
        if (removeExternalUrl(group.table, group.column, entry.rowId, entry.url)) {
          deleted.push(entry.key);
        }
      }
    }
    if (deleted.length > 0) {
      showToast(
        intl
          .get('external_urls.removed_broken_group', {
            count: deleted.length,
            table: group.table,
            column: group.column,
          })
          .d('Removed {count} broken URL(s) from {table}.{column}')
      );
      markDeleted(deleted);
    } else {
      showToast(
        intl.get('external_urls.no_broken_group').d('No broken URLs to remove in this group')
      );
    }
  };

  const handleDeleteAllBroken = () => {
    const deleted: string[] = [];
    for (const group of groups) {
      for (const entry of group.entries) {
        if (!isEntryDeleted(entry.key) && isBroken(entry.url)) {
          if (removeExternalUrl(group.table, group.column, entry.rowId, entry.url)) {
            deleted.push(entry.key);
          }
        }
      }
    }
    if (deleted.length > 0) {
      showToast(
        intl
          .get('external_urls.removed_broken_all', { count: deleted.length })
          .d('Removed {count} broken URL(s)')
      );
      markDeleted(deleted);
    } else {
      showToast(intl.get('external_urls.no_broken_all').d('No broken URLs to remove'));
    }
  };

  const verifyUrls = async (urls: string[]) => {
    setVerifying(true);
    setVerifyProgress(
      intl
        .get('external_urls.verifying', { current: 0, total: urls.length })
        .d('Verifying URLs ({current}/{total})...')
    );
    const newChecks: Record<string, UrlCheckResult> = {};
    for (let i = 0; i < urls.length; i += 5) {
      const batch = urls.slice(i, i + 5);
      setVerifyProgress(
        intl
          .get('external_urls.verifying', {
            current: Math.min(i + 5, urls.length),
            total: urls.length,
          })
          .d('Verifying URLs ({current}/{total})...')
      );
      const results = await Promise.all(batch.map(checkUrl));
      batch.forEach((url, j) => {
        newChecks[url] = results[j];
      });
      setLocalChecks((prev) => ({ ...prev, ...newChecks }));
    }
    setVerifying(false);
    setVerifyProgress('');
    if (onUrlChecksUpdate) {
      onUrlChecksUpdate({ ...urlChecks, ...newChecks });
    }
  };

  const handleVerifyAll = () => {
    const allUrls = Object.keys(externalUrls);
    verifyUrls(allUrls);
  };

  const handleVerifyGroup = (group: SourceGroup) => {
    const uniqueUrls = Array.from(new Set(group.entries.map((e) => e.url)));
    verifyUrls(uniqueUrls);
  };

  const totalOccurrences = Object.values(externalUrls).reduce((sum, s) => sum + s.length, 0);
  const deletedStyle: React.CSSProperties = { textDecoration: 'line-through', opacity: 0.5 };

  return (
    <div style={{ marginBottom: 16 }}>
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
          {intl
            .get('external_urls.title', { count: totalOccurrences })
            .d('External URLs ({count})')}
          {Object.keys(mergedChecks).length === 0 && (
            <span style={{ fontWeight: 400, fontSize: 12, color: '#e6a117', marginLeft: 8 }}>
              {intl.get('assets.url_unverified').d('unverified')}
            </span>
          )}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <ContextMenu
            onDelete={handleDeleteAllBroken}
            label={intl
              .get('external_urls.delete_all_broken')
              .d('Delete all broken URL references')}
          />
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
        <>
          {verifying ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 8px' }}>
              <div
                style={{
                  width: 16,
                  height: 16,
                  border: '2px solid #ff8000',
                  borderTopColor: 'transparent',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }}
              />
              <span style={{ fontSize: 13, color: '#666' }}>{verifyProgress}</span>
            </div>
          ) : (
            <div style={{ padding: '4px 8px', fontSize: 13 }}>
              <span
                onClick={handleVerifyAll}
                style={{ color: '#ff8000', cursor: 'pointer', userSelect: 'none' }}>
                {Object.keys(mergedChecks).length === 0
                  ? intl.get('external_urls.verify').d('Verify URLs')
                  : intl.get('external_urls.re_verify').d('Re-verify URLs')}
              </span>
              <span style={{ color: '#888', marginLeft: 8 }}>
                {Object.keys(mergedChecks).length > 0 &&
                  intl
                    .get('external_urls.verified_count', {
                      checked: Object.keys(mergedChecks).length,
                      total: urlCount,
                    })
                    .d('— {checked}/{total} unique URL(s) verified')}
                {Object.keys(mergedChecks).length === 0 &&
                  intl
                    .get('external_urls.verify_desc')
                    .d('— check external URLs for broken links via HEAD requests')}
              </span>
            </div>
          )}
          <div style={{ fontSize: 14 }}>
            {groups.map((group) => {
              const key = `${group.table}:::${group.column}`;
              const isOpen = expanded.has(key);
              const brokenInGroup = group.entries.filter(
                (e) => !isEntryDeleted(e.key) && isBroken(e.url)
              ).length;
              const groupDel = isGroupDeleted(group);
              return (
                <div key={key} style={{ marginBottom: 2 }}>
                  <div
                    className="asset-audit-group"
                    onClick={() => toggle(key)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 8px',
                      cursor: 'pointer',
                      borderRadius: 4,
                      backgroundColor: isOpen ? '#f0f4f8' : 'transparent',
                      ...(groupDel ? deletedStyle : {}),
                    }}>
                    {isOpen ? (
                      <FaChevronDown size={10} color="#999" />
                    ) : (
                      <FaChevronRight size={10} color="#999" />
                    )}
                    <span style={{ fontWeight: 500 }}>{group.table}</span>
                    <span style={{ color: '#999' }}>&rsaquo;</span>
                    <span>{group.column}</span>
                    <span style={{ color: '#6c757d', fontSize: 12 }}>
                      (
                      {intl
                        .get('external_urls.url_count', { count: group.entries.length })
                        .d('{count} URL(s)')}
                      {brokenInGroup > 0 && (
                        <span style={{ color: '#dc3545' }}>
                          {intl
                            .get('external_urls.broken_count', { count: brokenInGroup })
                            .d(', {count} broken')}
                        </span>
                      )}
                      )
                    </span>
                    {!groupDel && (
                      <span style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
                        <ContextMenu
                          onDelete={() => handleDeleteBrokenInGroup(group)}
                          label={intl
                            .get('external_urls.delete_broken')
                            .d('Delete broken URL references')}
                        />
                      </span>
                    )}
                  </div>
                  {isOpen && (
                    <div style={{ paddingLeft: 28 }}>
                      {group.entries.map((entry) => {
                        const check = mergedChecks[entry.url];
                        const st = check ? STATUS_STYLES[check.result] : undefined;
                        const entryDel = isEntryDeleted(entry.key);
                        return (
                          <div
                            key={entry.key}
                            className="asset-audit-row"
                            style={{
                              padding: '3px 8px',
                              color: '#555',
                              fontSize: 13,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              ...(entryDel ? deletedStyle : {}),
                            }}>
                            <FaExternalLinkAlt size={10} color="#999" />
                            <a
                              href={entry.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{
                                color: entryDel ? '#999' : '#0066cc',
                                wordBreak: 'break-all',
                                textDecoration: entryDel ? 'line-through' : 'none',
                                flex: 1,
                              }}>
                              {entry.url}
                            </a>
                            {check && st && (
                              <span
                                style={{
                                  fontSize: 11,
                                  color: st.color,
                                  backgroundColor:
                                    check.result === 'broken'
                                      ? '#fff5f5'
                                      : check.result === 'ok'
                                        ? '#f0fff0'
                                        : '#fff8e6',
                                  padding: '1px 6px',
                                  borderRadius: 3,
                                  whiteSpace: 'nowrap',
                                }}>
                                {check.code ? `${check.code}` : ''} {st.label}
                                {check.error && check.result !== 'unverifiable'
                                  ? ` (${check.error})`
                                  : ''}
                              </span>
                            )}
                            <span style={{ color: '#bbb', whiteSpace: 'nowrap' }}>
                              {intl
                                .get('external_urls.row_id', { id: entry.rowId })
                                .d('(row: {id})')}
                            </span>
                            {!entryDel && (
                              <ContextMenu
                                onDelete={() =>
                                  handleDelete(
                                    group.table,
                                    group.column,
                                    entry.url,
                                    entry.rowId,
                                    entry.key
                                  )
                                }
                                label={intl.get('external_urls.remove_url').d('Remove URL')}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

export default ExternalUrls;
