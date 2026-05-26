import React from 'react';
import intl from 'react-intl-universal';
import stylesPSettings from '../../../styles/template-styles/PluginSettings.module.scss';
import {
  getColumnRuleKindsInView,
  RULE_KIND_LABEL_SHORT,
} from '../../../utils/custom-utils/performanceAuditRunner';
import {
  PerformanceCandidateColumn,
  RemediatedColumnHide,
} from '../../../utils/custom-interfaces/AuditTypes';
import ChainGraph, { ChainGraphRoot } from './ChainGraph';
import ImpactBadge from './ImpactBadge';
import { impactBandFromPct, BAND_SORT_ORDER, ImpactBand } from './impactBands';

interface CandidateExpansionProps {
  candidate: PerformanceCandidateColumn;
  liveValue: any;
  viewEdits: Map<string, Set<string>>;
  onSetViewEdit: (viewId: string, hidden: Set<string>) => void;
  stagedHides: Map<string, RemediatedColumnHide>;
  costByKey: Map<string, number>;
  visibleRowsByKey: Map<string, number>;
  totalViewLoadMs: number;
  // Per-view total load ms keyed `${tableId}:${viewId}` — used to derive each
  // view's loading band (slow / moderate / fast). Sourced from the audit's
  // `result.views[].loadMs` so the band matches what the user sees on the
  // TableTab Views section.
  viewLoadMsByKey: Map<string, number>;
}

function candidateRoot(c: PerformanceCandidateColumn): ChainGraphRoot {
  if (c.columnType === 'link-formula') {
    return {
      columnType: 'link-formula',
      name: c.columnName,
      formulaType: c.formulaType,
      referencedLinkName: c.dependsOnLinkColumnName,
    };
  }
  if (c.columnType === 'link') {
    return { columnType: 'link', name: c.columnName };
  }
  return { columnType: 'formula', name: c.columnName };
}

/**
 * Single chevron-driven expansion for a candidate column row, shared by
 * Overview's Performance candidates table and TableTab's Columns table.
 *
 * Renders two stacked sections:
 *   1. Chain graph (when the candidate has a chain).
 *   2. Per-view drill — every view that displays this column in base, with a
 *      slider toggling hide-in-view. Slider state factors viewEdits if set,
 *      otherwise (base ∪ stagedHides_for_view), so freshly-staged hides
 *      mirror across surfaces and the candidate drill stays in sync with
 *      the per-view slider expansion.
 *
 * Returns null when neither section has content, so callers can detect
 * "nothing to expand" and suppress the chevron.
 */
const CandidateExpansion: React.FC<CandidateExpansionProps> = ({
  candidate: c,
  liveValue,
  viewEdits,
  onSetViewEdit,
  stagedHides,
  costByKey,
  visibleRowsByKey,
  totalViewLoadMs,
  viewLoadMsByKey,
}) => {
  const hasChain = !!c.chain && c.chain.length > 0;
  const stagedViewIdsForCol = (() => {
    const entry = stagedHides.get(`${c.tableId}:${c.columnKey}`);
    if (!entry) return new Set<string>();
    return new Set(entry.views.map((v) => v.viewId));
  })();

  const drillRows = (() => {
    const tables: any[] = liveValue?.tables || [];
    const t = tables.find((tt: any) => tt._id === c.tableId);
    if (!t)
      return [] as Array<{
        viewId: string;
        viewName: string;
        ruleKinds: string[];
        band: ImpactBand;
        isHidden: boolean;
      }>;
    const out: Array<{
      viewId: string;
      viewName: string;
      ruleKinds: string[];
      band: ImpactBand;
      isHidden: boolean;
    }> = [];
    for (const v of t.views || []) {
      const baseHidden = new Set<string>(v.hidden_columns || []);
      if (baseHidden.has(c.columnKey)) continue;
      const edits = viewEdits.get(v._id);
      const isHidden = edits ? edits.has(c.columnKey) : stagedViewIdsForCol.has(v._id);
      const ruleKinds = getColumnRuleKindsInView(v, c.columnKey);
      // Show each view's overall loading band — the user picks which views
      // to hide-in based on which views feel slow, not on a derived "% saved"
      // number. Within-band ordering preserves the savings ranking implicitly
      // (heavier views = larger drop when this column is hidden).
      const viewMs = viewLoadMsByKey.get(`${c.tableId}:${v._id}`) ?? 0;
      const viewPct = totalViewLoadMs > 0 ? (viewMs / totalViewLoadMs) * 100 : 0;
      const band = impactBandFromPct(viewPct);
      out.push({
        viewId: v._id,
        viewName: v.name,
        ruleKinds,
        band,
        isHidden,
      });
    }
    // Sort by band order (high → low → not-relevant). Within a band, preserve
    // the audit's natural per-view weight order via viewLoadMsByKey lookup.
    out.sort((a, b) => {
      const ord = BAND_SORT_ORDER[a.band] - BAND_SORT_ORDER[b.band];
      if (ord !== 0) return ord;
      const am = viewLoadMsByKey.get(`${c.tableId}:${a.viewId}`) ?? 0;
      const bm = viewLoadMsByKey.get(`${c.tableId}:${b.viewId}`) ?? 0;
      return bm - am;
    });
    return out;
  })();
  const hasDrill = drillRows.length > 0;
  if (!hasChain && !hasDrill) return null;

  const handleToggle = (viewId: string) => {
    const tables: any[] = liveValue?.tables || [];
    const t = tables.find((tt: any) => tt._id === c.tableId);
    const v = t?.views?.find((vv: any) => vv._id === viewId);
    const baseHidden = new Set<string>(v?.hidden_columns || []);
    // Merge in committed staged-hides for this view (any column in the table).
    const stagedForView = new Set<string>(baseHidden);
    stagedHides.forEach((h) => {
      if (h.tableId !== c.tableId) return;
      if (h.views.some((vv) => vv.viewId === viewId)) stagedForView.add(h.columnKey);
    });
    const current = new Set(viewEdits.get(viewId) ?? stagedForView);
    if (current.has(c.columnKey)) current.delete(c.columnKey);
    else current.add(c.columnKey);
    onSetViewEdit(viewId, current);
  };

  return (
    <>
      {hasChain && (
        <div style={{ marginLeft: 20 }}>
          <ChainGraph chain={c.chain!} rootColumn={candidateRoot(c)} />
        </div>
      )}
      {hasDrill && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            marginLeft: 20,
            marginTop: 6,
            padding: '6px 0',
            borderTop: hasChain ? '1px solid #eee' : 'none',
          }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>
            {intl
              .get('performance.hide_drill_title', { count: drillRows.length })
              .d(`Visible in ${drillRows.length} view(s) — hide where not needed:`)}
          </div>
          <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
            <tbody>
              {drillRows.map((row) => {
                const localizedKinds = row.ruleKinds
                  .map((k) => RULE_KIND_LABEL_SHORT[k] || k)
                  .join(', ');
                return (
                  <tr key={row.viewId}>
                    <td style={{ padding: '3px 8px 3px 0' }}>
                      <button
                        type="button"
                        onClick={() => handleToggle(row.viewId)}
                        title={
                          row.isHidden
                            ? intl.get('performance.toggle_show_col').d('Show in this view')
                            : intl.get('performance.toggle_hide_col').d('Hide in this view')
                        }
                        className={
                          !row.isHidden
                            ? stylesPSettings.settings_fields_toggle_btns_active
                            : stylesPSettings.settings_fields_toggle_btns
                        }
                      />
                    </td>
                    <td
                      style={{
                        padding: '3px 8px',
                        color: '#333',
                        minWidth: 200,
                      }}>
                      {row.viewName}
                      {row.ruleKinds.length > 0 && (
                        <i
                          className="dtable-font dtable-icon-rules"
                          title={intl
                            .get('performance.hide_rule_bound_tooltip', {
                              kinds: localizedKinds,
                            })
                            .d(
                              `Referenced by ${localizedKinds} in this view. Hiding doesn't reduce compute cost — the value is still needed to evaluate the rule.`
                            )}
                          style={{
                            fontSize: 12,
                            color: '#aaa',
                            marginLeft: 6,
                            cursor: 'help',
                          }}
                        />
                      )}
                    </td>
                    <td style={{ padding: '3px 8px' }}>
                      {row.ruleKinds.length > 0 ? (
                        <span
                          style={{
                            color: '#aaa',
                            fontStyle: 'italic',
                            fontSize: 12,
                          }}>
                          {intl
                            .get('performance.hide_used_in_rules_band', {
                              kinds: localizedKinds,
                            })
                            .d(`hiding doesn't help — used in ${localizedKinds}`)}
                        </span>
                      ) : (
                        <ImpactBadge band={row.band} surface="view" />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};

export default CandidateExpansion;

/**
 * True iff the candidate has anything to expand (chain or drill). Mirrors
 * the internal CandidateExpansion logic so callers can decide whether to
 * render an expand chevron without rendering the expansion itself.
 */
export function hasCandidateExpansionContent(
  candidate: PerformanceCandidateColumn,
  liveValue: any
): boolean {
  const hasChain = !!candidate.chain && candidate.chain.length > 0;
  if (hasChain) return true;
  const tables: any[] = liveValue?.tables || [];
  const t = tables.find((tt: any) => tt._id === candidate.tableId);
  if (!t) return false;
  for (const v of t.views || []) {
    const baseHidden = new Set<string>(v.hidden_columns || []);
    if (!baseHidden.has(candidate.columnKey)) return true;
  }
  return false;
}
