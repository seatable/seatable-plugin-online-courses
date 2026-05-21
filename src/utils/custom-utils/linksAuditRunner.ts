import {
  LinkColumnInfo,
  LinkFormulaInfo,
  LookupSuggestion,
  RedundantLink,
  LinksAuditResult,
} from '../custom-interfaces/AuditTypes';
import { buildChainForLinkFormula } from './performanceAuditRunner';
import { getAuthContext } from './authHelper';
import { PLUGIN_NAME } from '../template-constants';

function isEmpty(val: any): boolean {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string' && val.trim() === '') return true;
  if (Array.isArray(val) && val.length === 0) return true;
  return false;
}

// Extract {ColumnName.LookupColumn} references from formula text
function extractDotLookups(formula: string): { linkColName: string; targetColName: string }[] {
  const regex = /\{([^}.]+)\.([^}]+)\}/g;
  const results: { linkColName: string; targetColName: string }[] = [];
  let match;
  while ((match = regex.exec(formula)) !== null) {
    results.push({ linkColName: match[1], targetColName: match[2] });
  }
  return results;
}

// Extract link function calls: countlinks({Col}), rollup({Col}, ...), findmax({Col}, ...), findmin({Col}, ...)
const LINK_FUNCTIONS = ['countlinks', 'rollup', 'findmax', 'findmin'];
function extractLinkFunctions(formula: string): { funcName: string; linkColName: string }[] {
  const results: { funcName: string; linkColName: string }[] = [];
  for (const fn of LINK_FUNCTIONS) {
    const regex = new RegExp(fn + '\\s*\\(\\s*\\{([^}]+)\\}', 'gi');
    let match;
    while ((match = regex.exec(formula)) !== null) {
      results.push({ funcName: fn, linkColName: match[1] });
    }
  }
  return results;
}

// Build a map of option ID → option name for select columns
function buildOptionMap(col: any): Record<string, string> | null {
  if ((col.type === 'single-select' || col.type === 'multiple-select') && col.data?.options) {
    const map: Record<string, string> = {};
    for (const opt of col.data.options) {
      map[opt.id] = opt.name;
    }
    return map;
  }
  return null;
}

// Normalize a cell value for comparison, resolving select IDs to labels
function normalizeValue(val: any, optionMap?: Record<string, string> | null): string {
  if (isEmpty(val)) return '';
  if (typeof val === 'string') {
    const trimmed = val.trim();
    // Resolve single-select option ID to name
    if (optionMap && optionMap[trimmed]) return optionMap[trimmed];
    return trimmed;
  }
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) {
    return val
      .map((item) => {
        if (typeof item === 'string') {
          const trimmed = item.trim();
          // Resolve multi-select option IDs to names
          if (optionMap && optionMap[trimmed]) return optionMap[trimmed];
          return trimmed;
        }
        if (typeof item === 'object' && item !== null) {
          return item.display_value || item.name || item.email || JSON.stringify(item);
        }
        return String(item);
      })
      .sort()
      .join('|');
  }
  if (typeof val === 'object' && val !== null) return JSON.stringify(val);
  return String(val);
}

// For a link column, resolve the actual "other" table from the current table's perspective.
// col.data.table_id is always the source table, col.data.other_table_id is always the target.
// On the source table, the other table is other_table_id.
// On the mirror (target) table, the other table is table_id.
function resolveOtherTableId(currentTableId: string, colData: any): string {
  if (currentTableId === colData.table_id) {
    return colData.other_table_id;
  }
  return colData.table_id;
}

export async function runLinksAudit(
  checkLookups: boolean = false,
  onProgress?: (msg: string) => void
): Promise<LinksAuditResult> {
  const dtableSDK = (window as any).dtableSDK;
  const tables: any[] = dtableSDK.getTables();

  // Build table lookup maps
  const tableById: Record<string, any> = {};
  for (const t of tables) {
    tableById[t._id] = t;
  }

  // Get base-level link definitions to detect tables with missing link columns
  const storeLinks: any[] = dtableSDK.getLinks?.() || dtableSDK.dtableStore?.value?.links || [];

  // Find tables that are part of a link but have no link columns in the SDK
  // (SDK doesn't always load all columns for inactive tables)
  const tablesInLinks = new Set<string>();
  for (const link of storeLinks) {
    tablesInLinks.add(link.table1_id);
    tablesInLinks.add(link.table2_id);
  }

  const tablesNeedingFetch: any[] = [];
  for (const t of tables) {
    if (!tablesInLinks.has(t._id)) continue;
    const hasLinkCols = (t.columns || []).some((c: any) => c.type === 'link');
    if (!hasLinkCols) tablesNeedingFetch.push(t);
  }

  // Fetch full column lists via API for tables with missing columns
  if (tablesNeedingFetch.length > 0) {
    if (onProgress) onProgress(`Fetching columns for ${tablesNeedingFetch.length} table(s)...`);
    const { serverUrl, dtableUuid, accessToken: baseToken } = await getAuthContext();

    if (serverUrl && baseToken && dtableUuid) {
      for (const t of tablesNeedingFetch) {
        try {
          const resp = await fetch(
            `${serverUrl}/api-gateway/api/v2/dtables/${dtableUuid}/columns/?table_name=${encodeURIComponent(t.name)}`,
            { headers: { authorization: `Bearer ${baseToken}` } }
          );
          if (resp.ok) {
            const data = await resp.json();
            const apiColumns: any[] = data.columns || [];
            // Merge missing link columns into the table's column list
            const existingKeys = new Set((t.columns || []).map((c: any) => c.key));
            for (const col of apiColumns) {
              if (!existingKeys.has(col.key)) {
                t.columns.push(col);
              }
            }
          }
        } catch {
          // Ignore fetch errors, continue with partial data
        }
      }
    }
  }

  const linkColumns: LinkColumnInfo[] = [];
  const linkFormulas: LinkFormulaInfo[] = [];

  // Read the performance-audit's frozenColumns settings so we can flag any
  // self-link columns that were created by the freeze mechanism. They show
  // up in the Links audit with a "freeze helper" badge and are excluded from
  // redundancy / missing-mirror detection — they're an internal artifact, not
  // a structural finding.
  const freezeHelperKeys = new Set<string>();
  try {
    const settings = (window as any).dtableSDK?.getPluginSettings?.(PLUGIN_NAME) || {};
    const frozen = settings.frozenColumns || {};
    for (const k of Object.keys(frozen)) {
      const rec = frozen[k];
      if (rec?.selfLinkColumnKey && rec?.tableId) {
        freezeHelperKeys.add(`${rec.tableId}:${rec.selfLinkColumnKey}`);
      }
    }
  } catch {
    // Best-effort — if settings can't be read, fall through with no helpers flagged.
  }

  // Pre-scan all link columns across all tables (for mirror detection)
  const allLinkCols: { tableId: string; linkId: string; columnKey: string }[] = [];
  for (const table of tables) {
    for (const col of table.columns || []) {
      if (col.type === 'link' && col.data) {
        allLinkCols.push({
          tableId: table._id,
          linkId: col.data.link_id,
          columnKey: col.key,
        });
      }
    }
  }

  for (const table of tables) {
    if (onProgress) onProgress(`Scanning ${table.name}...`);

    const columns: any[] = table.columns || [];
    const rows: any[] = table.rows || [];
    const rowCount = rows.length;

    // Get link rows data for this table
    const tableLinkCols = columns.filter((c: any) => c.type === 'link');
    let linkRows: Record<string, Record<string, any[]>> = {};
    if (tableLinkCols.length > 0) {
      try {
        linkRows = dtableSDK.getTableLinkRows(rows, table) || {};
      } catch {
        linkRows = {};
      }
    }

    for (const col of columns) {
      if (col.type === 'link' && col.data) {
        const targetTableId = resolveOtherTableId(table._id, col.data);
        const targetTable = tableById[targetTableId];
        const targetTableName = targetTable ? targetTable.name : '(deleted table)';
        // Display column: first column of the target table
        const targetColumnName = targetTable?.columns?.[0]?.name || '';
        const linkId = col.data.link_id;
        const isSelfLink = col.data.table_id === col.data.other_table_id;

        // Mirror check: another link column on the target table with the same link_id
        const hasMirror = isSelfLink
          ? allLinkCols.filter((lc) => lc.tableId === table._id && lc.linkId === linkId).length >= 2
          : allLinkCols.some((lc) => lc.tableId === targetTableId && lc.linkId === linkId);

        // Count rows with at least one link
        let linkedRowCount = 0;
        for (const row of rows) {
          const rowLinks = linkRows[row._id];
          const linkedValues = rowLinks ? rowLinks[col.key] : null;
          if (!isEmpty(linkedValues)) {
            linkedRowCount++;
          }
        }

        // Outbound chain: target table + its display column (first column), recursing if it chains further
        const displayColKey = targetTable?.columns?.[0]?.key || '';
        const outboundChain = buildChainForLinkFormula(col, displayColKey, table, tableById);

        linkColumns.push({
          tableId: table._id,
          tableName: table.name,
          columnKey: col.key,
          columnName: col.name,
          targetTableId,
          targetTableName,
          targetColumnName,
          linkId,
          isSelfLink,
          hasMirror,
          linkedRowCount,
          totalRowCount: rowCount,
          fillRate: rowCount > 0 ? linkedRowCount / rowCount : 0,
          outboundChain,
          isFreezeHelper: freezeHelperKeys.has(`${table._id}:${col.key}`),
        });
      }

      // Link-formula columns (no fill rate — these are computed)
      if (col.type === 'link-formula' && col.data) {
        const formulaType = col.data.formula || col.data.type || 'unknown';
        const dependsOnKey = col.data.link_column_key || '';
        const dependsOnCol = columns.find((c: any) => c.key === dependsOnKey);
        const dependsOnName = dependsOnCol ? dependsOnCol.name : dependsOnKey;

        // Resolve target table (from the parent link column) and referenced column
        // For findmin/findmax: the relevant column is column_key_for_comparison
        // For rollup/lookup/count_links: it's level1_linked_table_column_key
        let targetTableName = '';
        let targetColumnName = '';
        let targetColumnIsLink = false;
        let targetColKey = '';
        if (dependsOnCol && dependsOnCol.data) {
          const tgtTable = tableById[resolveOtherTableId(table._id, dependsOnCol.data)];
          if (tgtTable) {
            targetTableName = tgtTable.name;
            targetColKey =
              formulaType === 'findmax' || formulaType === 'findmin'
                ? col.data.column_key_for_comparison ||
                  col.data.level1_linked_table_column_key ||
                  ''
                : col.data.level1_linked_table_column_key ||
                  col.data.column_key_in_linked_record ||
                  '';
            const targetCol = (tgtTable.columns || []).find((c: any) => c.key === targetColKey);
            targetColumnName = targetCol ? targetCol.name : targetColKey;
            targetColumnIsLink = targetCol?.type === 'link';
          }
        }

        const outboundChain = dependsOnCol
          ? buildChainForLinkFormula(dependsOnCol, targetColKey, table, tableById)
          : [];

        linkFormulas.push({
          tableId: table._id,
          tableName: table.name,
          columnKey: col.key,
          columnName: col.name,
          columnType: 'link-formula',
          formulaType,
          dependsOnColumnKey: dependsOnKey,
          dependsOnColumnName: dependsOnName,
          targetTableName,
          targetColumnName,
          targetColumnIsLink,
          outboundChain,
        });
      }

      // Formula columns that reference link columns
      if (col.type === 'formula' && col.data?.formula) {
        const formulaText: string = col.data.formula;

        // Detect {LinkColumn.LookupColumn} dot-notation lookups
        const dotLookups = extractDotLookups(formulaText);
        for (const dl of dotLookups) {
          const linkCol = columns.find((c: any) => c.type === 'link' && c.name === dl.linkColName);
          if (linkCol && linkCol.data) {
            const tgtTable = tableById[resolveOtherTableId(table._id, linkCol.data)];
            const tgtCol = tgtTable
              ? (tgtTable.columns || []).find((c: any) => c.name === dl.targetColName)
              : null;
            const outboundChain = buildChainForLinkFormula(
              linkCol,
              tgtCol?.key || '',
              table,
              tableById
            );
            linkFormulas.push({
              tableId: table._id,
              tableName: table.name,
              columnKey: col.key,
              columnName: col.name,
              columnType: 'formula',
              formulaType: 'lookup',
              dependsOnColumnKey: linkCol.key,
              dependsOnColumnName: linkCol.name,
              targetTableName: tgtTable ? tgtTable.name : '',
              targetColumnName: dl.targetColName,
              targetColumnIsLink: tgtCol?.type === 'link',
              outboundChain,
            });
          }
        }

        // Detect countlinks({Col}), rollup({Col}, ...), findmax({Col}, ...), findmin({Col}, ...)
        const linkFuncs = extractLinkFunctions(formulaText);
        for (const lf of linkFuncs) {
          const linkCol = columns.find((c: any) => c.type === 'link' && c.name === lf.linkColName);
          if (linkCol && linkCol.data) {
            const tgtTable = tableById[resolveOtherTableId(table._id, linkCol.data)];
            // countlinks has no target column; others may reference one implicitly
            const outboundChain = buildChainForLinkFormula(linkCol, '', table, tableById);
            linkFormulas.push({
              tableId: table._id,
              tableName: table.name,
              columnKey: col.key,
              columnName: col.name,
              columnType: 'formula',
              formulaType: lf.funcName,
              dependsOnColumnKey: linkCol.key,
              dependsOnColumnName: linkCol.name,
              targetTableName: tgtTable ? tgtTable.name : '',
              targetColumnName: '',
              targetColumnIsLink: false,
              outboundChain,
            });
          }
        }
      }
    }
  }

  // Detect redundant relationships: same pair of tables linked by multiple distinct link_ids
  // Only keep one column per link_id (skip mirrors) so mirrors don't appear as redundant.
  // Freeze-helper self-links are skipped — they're an internal artifact, not a real
  // user-modelled redundancy.
  const pairMap: Record<string, LinkColumnInfo[]> = {};
  const seenLinkIds = new Set<string>();
  for (const lc of linkColumns) {
    if (lc.isFreezeHelper) continue;
    if (seenLinkIds.has(lc.linkId)) continue;
    seenLinkIds.add(lc.linkId);
    const ids = [lc.tableId, lc.targetTableId].sort();
    const pairKey = ids.join('::');
    if (!pairMap[pairKey]) pairMap[pairKey] = [];
    pairMap[pairKey].push(lc);
  }

  const redundantLinks: RedundantLink[] = [];
  for (const [, cols] of Object.entries(pairMap)) {
    const distinctLinkIds = new Set(cols.map((c) => c.linkId));
    if (distinctLinkIds.size > 1) {
      redundantLinks.push({
        tableAId: cols[0].tableId,
        tableAName: cols[0].tableName,
        tableBId: cols[0].targetTableId,
        tableBName: cols[0].targetTableName,
        columns: cols.map((c) => ({
          columnName: c.columnName,
          linkId: c.linkId,
          tableName: c.tableName,
        })),
      });
    }
  }

  // Freeze helpers are populated 1:1 (every row → itself) and have no mirror by
  // design (self-link). Excluding them from both findings keeps the audit
  // focused on real structural issues.
  const unusedLinks = linkColumns.filter((lc) => lc.fillRate === 0 && !lc.isFreezeHelper);
  const missingMirrors = linkColumns.filter((lc) => !lc.hasMirror && !lc.isFreezeHelper);

  // Detect columns that could be replaced by a lookup
  const lookupSuggestions: LookupSuggestion[] = [];
  const COMPUTED_TYPES = new Set([
    'formula',
    'link-formula',
    'link',
    'ctime',
    'mtime',
    'creator',
    'last-modifier',
    'auto-number',
    'button',
  ]);

  if (checkLookups) {
    const dtableSDK = (window as any).dtableSDK;
    const tables: any[] = dtableSDK.getTables();

    for (const table of tables) {
      if (onProgress) onProgress(`Checking lookups for ${table.name}...`);

      const columns: any[] = table.columns || [];
      const rows: any[] = table.rows || [];
      if (rows.length === 0) continue;

      const tableLinkCols = columns.filter((c: any) => c.type === 'link' && c.data);
      if (tableLinkCols.length === 0) continue;

      // Get link rows for this table
      let linkRows: Record<string, Record<string, any[]>> = {};
      try {
        linkRows = dtableSDK.getTableLinkRows(rows, table) || {};
      } catch {
        continue;
      }

      // Candidate columns: non-computed columns with some data
      const candidateCols = columns.filter(
        (c: any) => !COMPUTED_TYPES.has(c.type) && rows.some((r) => !isEmpty(r[c.key]))
      );

      for (const linkCol of tableLinkCols) {
        const targetTable = tableById[resolveOtherTableId(table._id, linkCol.data)];
        if (!targetTable) continue;
        const targetColumns: any[] = targetTable.columns || [];

        // Build id→row map from target table rows (more reliable than id_row_map)
        const targetRowById: Record<string, any> = {};
        for (const r of targetTable.rows || []) {
          targetRowById[r._id] = r;
        }

        for (const candidate of candidateCols) {
          const candidateOptionMap = buildOptionMap(candidate);

          for (const targetCol of targetColumns) {
            // Skip computed/link columns on target side too
            if (COMPUTED_TYPES.has(targetCol.type)) continue;

            const targetOptionMap = buildOptionMap(targetCol);

            let matched = 0;
            let compared = 0;
            let broken = false;

            for (const row of rows) {
              const localVal = normalizeValue(row[candidate.key], candidateOptionMap);
              if (localVal === '') continue; // skip empty local values

              // Get linked row(s) for this link column
              const rowLinks = linkRows[row._id];
              const linkedValues = rowLinks ? rowLinks[linkCol.key] : null;
              if (isEmpty(linkedValues) || !Array.isArray(linkedValues)) {
                // Local value exists but no linked record — can't be a lookup
                broken = true;
                break;
              }

              // For single-link (most common), compare with the first linked row
              const linkedRowId =
                typeof linkedValues[0] === 'object' ? linkedValues[0]._id : linkedValues[0];
              const linkedRow = targetRowById[linkedRowId];
              if (!linkedRow) {
                broken = true;
                break;
              }

              compared++;
              const targetVal = normalizeValue(linkedRow[targetCol.key], targetOptionMap);
              if (localVal === targetVal) {
                matched++;
              }
            }

            // Suggest if no broken rows, enough compared, and all matched
            if (!broken && compared >= 2 && matched === compared) {
              lookupSuggestions.push({
                tableName: table.name,
                columnName: candidate.name,
                columnKey: candidate.key,
                columnType: candidate.type,
                linkColumnName: linkCol.name,
                linkColumnKey: linkCol.key,
                targetTableName: targetTable.name,
                targetColumnName: targetCol.name,
                targetColumnKey: targetCol.key,
              });
            }
          }
        }
      }
    }
  }

  return {
    linkColumns,
    linkFormulas,
    redundantLinks,
    unusedLinks,
    missingMirrors,
    lookupSuggestions,
  };
}
