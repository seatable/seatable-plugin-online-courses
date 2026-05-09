import React, { useState } from 'react';
import intl from 'react-intl-universal';
import {
  LinkColumnInfo,
  LinkFormulaInfo,
  RedundantLink,
} from '../../../utils/custom-interfaces/AuditTypes';
import ContextMenu from '../shared/ContextMenu';
import { showToast } from '../shared/showToast';
import ChainGraph, { ChainGraphRoot } from '../shared/ChainGraph';

interface TableGroupProps {
  tableName: string;
  linkColumns: LinkColumnInfo[];
  linkFormulas: LinkFormulaInfo[];
  redundantLinks: RedundantLink[];
  defaultOpen: boolean;
  // When true, every link col and every formula starts expanded. The parent
  // remounts TableGroup on its page-level Expand-all toggle, so this only
  // needs to seed the initial state.
  defaultExpandAll?: boolean;
  onRefresh: () => void;
}

function formulaKey(c: LinkFormulaInfo): string {
  return `${c.tableId}-${c.columnKey}-${c.formulaType}-${c.targetColumnName}`;
}

function deleteColumn(tableName: string, columnKey: string): boolean {
  try {
    const dtableSDK = (window as any).dtableSDK;
    const tables = dtableSDK.getTables();
    const tableIndex = tables.findIndex((t: any) => t.name === tableName);
    if (tableIndex < 0) return false;
    const table = tables[tableIndex];
    const column = table.columns.find((c: any) => c.key === columnKey);
    if (!column) return false;
    dtableSDK.dtableStore.deleteColumn(tableIndex, column.key, column);
    return true;
  } catch (err) {
    console.error('Failed to delete column:', err);
    return false;
  }
}

const Badge: React.FC<{ label: string; color: string; bg: string }> = ({ label, color, bg }) => (
  <span
    style={{
      fontSize: 11,
      color,
      backgroundColor: bg,
      padding: '1px 6px',
      borderRadius: 3,
      marginLeft: 6,
    }}>
    {label}
  </span>
);

function consumerRoot(c: LinkFormulaInfo): ChainGraphRoot {
  if (c.columnType === 'link-formula') {
    return {
      columnType: 'link-formula',
      name: c.columnName,
      formulaType: c.formulaType,
      referencedLinkName: c.dependsOnColumnName,
    };
  }
  return { columnType: 'formula', name: c.columnName };
}

function isRedundant(lc: LinkColumnInfo, redundantLinks: RedundantLink[]): boolean {
  return redundantLinks.some((r) =>
    r.columns.some(
      (c) =>
        c.columnName === lc.columnName && c.tableName === lc.tableName && c.linkId === lc.linkId
    )
  );
}

const FillSummary: React.FC<{
  rate: number;
  count: number;
  total: number;
  consumers: number;
}> = ({ rate, count, total, consumers }) => {
  const fillText = intl
    .get('links.fill_rate', { filled: count, total, pct: (rate * 100).toFixed(0) })
    .d('{filled}/{total} rows — {pct}%');
  const usedByText =
    consumers > 0
      ? intl.get('links.used_by_count', { count: consumers }).d('Used by {count} column(s)')
      : '';
  return (
    <span style={{ color: '#888', fontSize: 12 }}>
      ({fillText}
      {usedByText ? `, ${usedByText}` : ''})
    </span>
  );
};

const ConsumerRow: React.FC<{
  consumer: LinkFormulaInfo;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}> = ({ consumer, expanded, onToggle, onDelete }) => {
  const icon =
    consumer.columnType === 'formula' ? 'dtable-icon-formula' : 'dtable-icon-link-formulas';
  const hasChain = !!consumer.outboundChain && consumer.outboundChain.length > 0;
  return (
    <div style={{ marginTop: 8 }}>
      <div
        onClick={hasChain ? onToggle : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          cursor: hasChain ? 'pointer' : undefined,
          userSelect: hasChain ? 'none' : undefined,
        }}>
        {hasChain ? (
          <i
            className={`dtable-font ${expanded ? 'dtable-icon-down' : 'dtable-icon-right'}`}
            style={{ fontSize: 10, color: '#888', width: 10, flexShrink: 0 }}
          />
        ) : (
          <span style={{ width: 10, flexShrink: 0 }} />
        )}
        <i className={`dtable-font ${icon}`} style={{ fontSize: 14, color: '#aaa' }} />
        <span>{consumer.columnName}</span>
        <span style={{ color: '#888', fontSize: 12 }}>— {consumer.formulaType}</span>
        <span style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
          <ContextMenu
            onDelete={onDelete}
            label={intl.get('common.delete_column').d('Delete column')}
          />
        </span>
      </div>
      {expanded && hasChain && (
        <div style={{ paddingLeft: 20 }}>
          <ChainGraph
            chain={consumer.outboundChain!}
            rootColumn={consumerRoot(consumer)}
          />
        </div>
      )}
    </div>
  );
};

const TableGroup: React.FC<TableGroupProps> = ({
  tableName,
  linkColumns,
  linkFormulas,
  redundantLinks,
  defaultOpen,
  defaultExpandAll = false,
  onRefresh,
}) => {
  // Group link-formulas by the link column they depend on
  const formulasByLinkKey: Record<string, LinkFormulaInfo[]> = {};
  const orphanedFormulas: LinkFormulaInfo[] = [];
  const linkColumnKeys = new Set(linkColumns.map((lc) => lc.columnKey));

  for (const lf of linkFormulas) {
    if (linkColumnKeys.has(lf.dependsOnColumnKey)) {
      if (!formulasByLinkKey[lf.dependsOnColumnKey]) formulasByLinkKey[lf.dependsOnColumnKey] = [];
      formulasByLinkKey[lf.dependsOnColumnKey].push(lf);
    } else {
      orphanedFormulas.push(lf);
    }
  }

  // Stable sets of "expandable" keys, used for the section-level expand-all toggle
  // and for seeding initial state when defaultExpandAll is on.
  const expandableLinkKeys = linkColumns
    .filter(
      (lc) =>
        (lc.outboundChain && lc.outboundChain.length > 0) ||
        (formulasByLinkKey[lc.columnKey]?.length ?? 0) > 0
    )
    .map((lc) => `${lc.tableId}-${lc.columnKey}`);
  const expandableFormulaKeys = [
    ...Object.values(formulasByLinkKey).flat(),
    ...orphanedFormulas,
  ]
    .filter((c) => c.outboundChain && c.outboundChain.length > 0)
    .map(formulaKey);

  const [open, setOpen] = useState(defaultOpen);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(
    () => new Set(defaultExpandAll ? expandableLinkKeys : [])
  );
  const [expandedFormulas, setExpandedFormulas] = useState<Set<string>>(
    () => new Set(defaultExpandAll ? expandableFormulaKeys : [])
  );

  const totalItems = linkColumns.length + linkFormulas.length;
  if (totalItems === 0) return null;

  const allExpanded =
    expandableLinkKeys.every((k) => expandedRows.has(k)) &&
    expandableFormulaKeys.every((k) => expandedFormulas.has(k)) &&
    expandableLinkKeys.length + expandableFormulaKeys.length > 0;

  const toggleAllInSection = () => {
    if (allExpanded) {
      setExpandedRows(new Set());
      setExpandedFormulas(new Set());
    } else {
      setExpandedRows(new Set(expandableLinkKeys));
      setExpandedFormulas(new Set(expandableFormulaKeys));
    }
  };

  const toggleRow = (key: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleFormula = (key: string) => {
    setExpandedFormulas((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const unusedColumns = linkColumns.filter((lc) => lc.fillRate === 0);

  const handleDelete = (colKey: string, colName: string) => {
    if (deleteColumn(tableName, colKey)) {
      showToast(`Deleted column "${colName}" from ${tableName}`);
      onRefresh();
    }
  };

  return (
    <div style={{ marginBottom: 4 }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px',
          cursor: 'pointer',
          userSelect: 'none',
          borderRadius: 4,
        }}
        className="asset-audit-group">
        <i
          className={`dtable-font ${open ? 'dtable-icon-down' : 'dtable-icon-right'}`}
          style={{ fontSize: 10, color: '#666' }}
        />
        <span style={{ fontWeight: 600, fontSize: 14 }}>{tableName}</span>
        <span style={{ color: '#888', fontSize: 12 }}>
          ({intl.get('links.link_count', { count: linkColumns.length }).d('{count} link(s)')}
          {linkFormulas.length > 0 &&
            intl
              .get('links.formula_count', { count: linkFormulas.length })
              .d(', {count} formula(s)')}
          )
        </span>
        {open && (expandableLinkKeys.length + expandableFormulaKeys.length) > 0 && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              toggleAllInSection();
            }}
            style={{
              marginLeft: 'auto',
              fontSize: 11,
              color: '#ff8000',
              cursor: 'pointer',
              userSelect: 'none',
            }}>
            {allExpanded
              ? intl.get('common.collapse_all').d('Collapse all')
              : intl.get('common.expand_all').d('Expand all')}
          </span>
        )}
        {unusedColumns.length > 0 && (
          <span
            style={{
              marginLeft:
                open && (expandableLinkKeys.length + expandableFormulaKeys.length) > 0
                  ? 8
                  : 'auto',
            }}
            onClick={(e) => e.stopPropagation()}>
            <ContextMenu
              onDelete={() => {
                let deleted = 0;
                for (const col of unusedColumns) {
                  if (deleteColumn(tableName, col.columnKey)) deleted++;
                }
                if (deleted > 0) {
                  showToast(
                    `Deleted ${deleted} unused column${deleted > 1 ? 's' : ''} from ${tableName}`
                  );
                  onRefresh();
                }
              }}
              label={intl
                .get('links.delete_unused', { count: unusedColumns.length })
                .d('Delete {count} unused column(s)')}
            />
          </span>
        )}
      </div>

      {open && (
        <div style={{ paddingLeft: 24 }}>
          {linkColumns.map((lc) => {
            const key = `${lc.tableId}-${lc.columnKey}`;
            const consumers = formulasByLinkKey[lc.columnKey] || [];
            const hasDetails =
              (lc.outboundChain && lc.outboundChain.length > 0) || consumers.length > 0;
            const isExpanded = expandedRows.has(key);
            return (
              <div
                key={key}
                className="asset-audit-row"
                style={{
                  padding: '6px 8px',
                  fontSize: 13,
                }}>
                <div
                  onClick={hasDetails ? () => toggleRow(key) : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    cursor: hasDetails ? 'pointer' : undefined,
                    userSelect: hasDetails ? 'none' : undefined,
                  }}>
                  {hasDetails ? (
                    <i
                      className={`dtable-font ${isExpanded ? 'dtable-icon-down' : 'dtable-icon-right'}`}
                      style={{ fontSize: 10, color: '#888', width: 10, flexShrink: 0 }}
                    />
                  ) : (
                    <span style={{ width: 10, flexShrink: 0 }} />
                  )}
                  <i
                    className="dtable-font dtable-icon-link-other-record"
                    style={{ fontSize: 14, color: '#aaa' }}
                  />
                  <span>{lc.columnName}</span>
                  {lc.isSelfLink && (
                    <span style={{ color: '#888', fontSize: 11 }}>
                      ({intl.get('common.self').d('self')})
                    </span>
                  )}
                  <FillSummary
                    rate={lc.fillRate}
                    count={lc.linkedRowCount}
                    total={lc.totalRowCount}
                    consumers={consumers.length}
                  />
                  {lc.fillRate === 0 && (
                    <Badge
                      label={intl.get('links.unused').d('unused')}
                      color="#856404"
                      bg="#fff3cd"
                    />
                  )}
                  {!lc.hasMirror && (
                    <Badge
                      label={intl.get('links.no_mirror').d('no mirror')}
                      color="#721c24"
                      bg="#f8d7da"
                    />
                  )}
                  {isRedundant(lc, redundantLinks) && (
                    <Badge
                      label={intl.get('links.redundant').d('redundant')}
                      color="#856404"
                      bg="#fff3cd"
                    />
                  )}
                  <span style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
                    <ContextMenu
                      onDelete={() => handleDelete(lc.columnKey, lc.columnName)}
                      label={intl.get('common.delete_column').d('Delete column')}
                    />
                  </span>
                </div>
                {hasDetails && isExpanded && (
                  <div style={{ paddingLeft: 20, marginTop: 4 }}>
                    {lc.outboundChain && lc.outboundChain.length > 0 && (
                      <ChainGraph
                        chain={lc.outboundChain}
                        rootColumn={{ columnType: 'link', name: lc.columnName }}
                      />
                    )}
                    {consumers.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 12, color: '#666', fontWeight: 500 }}>
                          {intl.get('links.used_by').d('Used by')}
                        </div>
                        {consumers.map((c) => {
                          const fk = formulaKey(c);
                          return (
                            <ConsumerRow
                              key={fk}
                              consumer={c}
                              expanded={expandedFormulas.has(fk)}
                              onToggle={() => toggleFormula(fk)}
                              onDelete={() => handleDelete(c.columnKey, c.columnName)}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {/* Formulas whose parent link column was not found in this table */}
          {orphanedFormulas.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {orphanedFormulas.map((lf) => {
                const fk = formulaKey(lf);
                return (
                  <ConsumerRow
                    key={`${lf.tableId}-${lf.columnKey}-orphan`}
                    consumer={lf}
                    expanded={expandedFormulas.has(fk)}
                    onToggle={() => toggleFormula(fk)}
                    onDelete={() => handleDelete(lf.columnKey, lf.columnName)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TableGroup;
