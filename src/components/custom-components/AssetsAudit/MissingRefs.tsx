import React, { useState } from 'react';
import intl from 'react-intl-universal';
import { RefSource } from '../../../utils/custom-interfaces/AuditTypes';
import { FaChevronRight, FaChevronDown } from 'react-icons/fa';
import ContextMenu from '../shared/ContextMenu';
import { showToast } from '../shared/showToast';
import { iconForColumnType } from '../shared/columnTypeIcons';

interface MissingRefsProps {
  missingRefs: string[];
  refSources: Record<string, RefSource[]>;
  refDisplayNames?: Record<string, string>;
  onRefresh: () => void;
}

interface SourceGroup {
  table: string;
  column: string;
  entries: { path: string; rowId: string; key: string }[];
}

function removeMissingRef(
  tableName: string,
  columnName: string,
  rowId: string,
  missingPath: string
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
        return !url.includes(missingPath) && !missingPath.includes(url);
      });
      dtableSDK.modifyRow(table, row, { [column.name]: filtered.length > 0 ? filtered : null });
    } else {
      dtableSDK.modifyRow(table, row, { [column.name]: null });
    }
    return true;
  } catch (err) {
    console.error('Failed to remove missing ref:', err);
    return false;
  }
}

const MissingRefs: React.FC<MissingRefsProps> = ({ missingRefs, refSources, refDisplayNames }) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sectionOpen, setSectionOpen] = useState(true);
  const [deletedKeys, setDeletedKeys] = useState<Set<string>>(new Set());

  if (missingRefs.length === 0) {
    return (
      <div style={{ color: '#28a745', padding: '8px 0' }}>
        {intl.get('missing_refs.none_found').d('No missing references found.')}
      </div>
    );
  }

  const bySource: Record<string, { path: string; rowId: string; key: string }[]> = {};
  for (const path of missingRefs) {
    const sources = refSources[path] || [
      { tableName: 'unknown', columnName: 'unknown', rowId: 'unknown' },
    ];
    for (const source of sources) {
      const groupKey = `${source.tableName}:::${source.columnName}`;
      if (!bySource[groupKey]) bySource[groupKey] = [];
      const entryKey = `${source.tableName}:::${source.columnName}:::${source.rowId}:::${path}`;
      bySource[groupKey].push({ path, rowId: source.rowId, key: entryKey });
    }
  }

  const groups: SourceGroup[] = Object.entries(bySource)
    .map(([key, entries]) => {
      const [table, column] = key.split(':::');
      return { table, column, entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
    })
    .sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));

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

  const handleDelete = (
    table: string,
    column: string,
    path: string,
    rowId: string,
    entryKey: string
  ) => {
    if (removeMissingRef(table, column, rowId, path)) {
      showToast(
        intl
          .get('missing_refs.removed_ref', { table, column })
          .d('Removed missing reference from {table}.{column}')
      );
      markDeleted([entryKey]);
    }
  };

  const handleDeleteGroup = (group: SourceGroup) => {
    const deleted: string[] = [];
    for (const entry of group.entries) {
      if (
        !isEntryDeleted(entry.key) &&
        removeMissingRef(group.table, group.column, entry.rowId, entry.path)
      ) {
        deleted.push(entry.key);
      }
    }
    if (deleted.length > 0) {
      showToast(
        intl
          .get('missing_refs.removed_refs_group', {
            count: deleted.length,
            table: group.table,
            column: group.column,
          })
          .d('Removed {count} missing reference(s) from {table}.{column}')
      );
      markDeleted(deleted);
    }
  };

  const handleDeleteAll = () => {
    const deleted: string[] = [];
    for (const group of groups) {
      for (const entry of group.entries) {
        if (
          !isEntryDeleted(entry.key) &&
          removeMissingRef(group.table, group.column, entry.rowId, entry.path)
        ) {
          deleted.push(entry.key);
        }
      }
    }
    if (deleted.length > 0) {
      showToast(
        intl
          .get('missing_refs.removed_refs_all', { count: deleted.length })
          .d('Removed {count} missing reference(s)')
      );
      markDeleted(deleted);
    }
  };

  const allKeys = groups.map((g) => `${g.table}:::${g.column}`);
  const allExpanded = allKeys.length > 0 && allKeys.every((k) => expanded.has(k));

  const toggleAll = () => {
    if (allExpanded) {
      setExpanded(new Set());
    } else {
      setExpanded(new Set(allKeys));
    }
  };

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
            .get('missing_refs.title', { count: missingRefs.length })
            .d('Missing references ({count})')}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <ContextMenu
            onDelete={handleDeleteAll}
            label={intl.get('missing_refs.delete_missing').d('Delete missing references')}
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
        <div style={{ fontSize: 14 }}>
          {groups.map((group) => {
            const key = `${group.table}:::${group.column}`;
            const isOpen = expanded.has(key);
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
                    backgroundColor: isOpen ? '#fff5f5' : 'transparent',
                    ...(groupDel ? deletedStyle : {}),
                  }}>
                  {isOpen ? (
                    <FaChevronDown size={10} color="#999" />
                  ) : (
                    <FaChevronRight size={10} color="#999" />
                  )}
                  <span style={{ fontWeight: 700 }}>{group.table}</span>
                  <span style={{ color: '#999' }}>&rsaquo;</span>
                  {(() => {
                    const sdkTables = (window as any).dtableSDK?.getTables?.() || [];
                    const t = sdkTables.find((x: any) => x.name === group.table);
                    const c = t?.columns?.find((x: any) => x.name === group.column);
                    return (
                      <i
                        className={`dtable-font ${iconForColumnType(c?.type)}`}
                        style={{ fontSize: 14, color: '#aaa' }}
                      />
                    );
                  })()}
                  <span>{group.column}</span>
                  <span style={{ color: '#dc3545', fontSize: 12 }}>
                    ({group.entries.length} {intl.get('missing_refs.missing_badge').d('missing')})
                  </span>
                  {!groupDel && (
                    <span style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
                      <ContextMenu
                        onDelete={() => handleDeleteGroup(group)}
                        label={intl
                          .get('missing_refs.delete_missing')
                          .d('Delete missing references')}
                      />
                    </span>
                  )}
                </div>
                {isOpen && (
                  <div style={{ paddingLeft: 28 }}>
                    {group.entries.map((entry) => {
                      const entryDel = isEntryDeleted(entry.key);
                      return (
                        <div
                          key={entry.key}
                          className="asset-audit-row"
                          style={{
                            padding: '3px 8px',
                            color: '#888',
                            fontSize: 13,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            ...(entryDel ? deletedStyle : {}),
                          }}>
                          <span style={{ color: '#dc3545' }}>&#x2717;</span>
                          <span style={{ wordBreak: 'break-all', flex: 1 }}>
                            {refDisplayNames?.[entry.path] ? (
                              <>
                                {refDisplayNames[entry.path]}{' '}
                                <span style={{ color: '#bbb', fontSize: 11 }}>({entry.path})</span>
                              </>
                            ) : (
                              entry.path
                            )}
                          </span>
                          <span style={{ color: '#bbb', whiteSpace: 'nowrap' }}>
                            {intl.get('external_urls.row_id', { id: entry.rowId }).d('(row: {id})')}
                          </span>
                          {!entryDel && (
                            <ContextMenu
                              onDelete={() =>
                                handleDelete(
                                  group.table,
                                  group.column,
                                  entry.path,
                                  entry.rowId,
                                  entry.key
                                )
                              }
                              label={intl.get('missing_refs.remove_ref').d('Remove reference')}
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
      )}
    </div>
  );
};

export default MissingRefs;
