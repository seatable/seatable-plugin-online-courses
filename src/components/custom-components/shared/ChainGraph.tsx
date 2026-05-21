import React, { useContext } from 'react';
import intl from 'react-intl-universal';
import { ChainNode } from '../../../utils/custom-interfaces/AuditTypes';
import { colorForTable, TableColorContext, TableColorMap } from './tablePalette';

export const COL_ICONS: Record<string, string> = {
  text: 'dtable-icon-single-line-text',
  'long-text': 'dtable-icon-long-text',
  number: 'dtable-icon-number',
  checkbox: 'dtable-icon-check-square-solid',
  date: 'dtable-icon-calendar-alt-solid',
  'single-select': 'dtable-icon-single-election',
  'multiple-select': 'dtable-icon-multiple-selection',
  image: 'dtable-icon-picture',
  file: 'dtable-icon-file',
  collaborator: 'dtable-icon-collaborator',
  link: 'dtable-icon-link-other-record',
  'link-formula': 'dtable-icon-link-formulas',
  formula: 'dtable-icon-formula',
};

// Layout constants. ROW_H is shared between col-rows and table-label rows so
// the L-curve geometry (vertical + bend) stays uniform regardless of which
// row sits between two dots.
const ROW_H = 22;
const GAP = 4;
const INDENT = 18;
const DOT_R = 4;
const CURVE_R = 6;

const REFERENCE_STROKE = 'lightgray';
const REFERENCE_WIDTH = 0.5; // user spec: ".3 and lightgray"; 0.5 is the
// smallest width that reliably renders across browsers; if the visual is
// too thin we can bump up.
const TRAVERSAL_WIDTH = 2;
const TRAVERSAL_OPACITY = 0.5;
const HEAD_RING = '#aaa';

export type ChainGraphRoot =
  | { columnType: 'link'; name: string }
  | {
      columnType: 'link-formula';
      name: string;
      formulaType?: string;
      referencedLinkName?: string;
    }
  | { columnType: 'formula'; name: string };

interface ChainGraphProps {
  chain: ChainNode[];
  rootColumn: ChainGraphRoot;
}

type EdgeKind = 'reference' | 'traversal' | 'none';

interface ColRow {
  kind: 'col';
  depth: number;
  iconClass: string;
  name: string;
  edge: EdgeKind;
  parentIdx: number | null;
  edgeColor?: string;
  tintColor?: string;
  // Only set on traversal arrival rows: the target table whose color this
  // row carries. Used by the table-label row above it to color the bold
  // table name in the same hue.
  targetTableName?: string;
}

interface TableLabelRow {
  kind: 'tableLabel';
  depth: number;
  tableName: string;
  tableRows: number;
  color: string;
}

type DisplayRow = ColRow | TableLabelRow;

function buildRows(
  chain: ChainNode[],
  root: ChainGraphRoot,
  colorMap: TableColorMap | null
): DisplayRow[] {
  const resolveColor = (name: string): string => {
    if (colorMap) {
      const c = colorMap.get(name);
      if (c) return c;
    }
    return colorForTable(name);
  };
  const rows: DisplayRow[] = [];

  // No head row: the chain is always rendered under the consumer's column
  // header, which already names the column. For link-formula with a known
  // referenced link, that link column is a *different* column from the
  // consumer's, so it leads the chain at depth 0 and carries the reference
  // edge from a virtual "formula above" parent.
  let firstTraversalParent: number | null = null;
  let firstTraversalParentDepth = -1;

  if (root.columnType === 'link-formula' && root.referencedLinkName) {
    rows.push({
      kind: 'col',
      depth: 0,
      iconClass: 'dtable-icon-link-other-record',
      name: root.referencedLinkName,
      edge: 'reference',
      parentIdx: null,
    });
    firstTraversalParent = 0;
    firstTraversalParentDepth = 0;
  }

  function walk(nodes: ChainNode[], parentIdx: number | null, parentDepth: number): void {
    for (const node of nodes) {
      const tableColor = resolveColor(node.tableName);
      const labelDepth = parentDepth + 1;
      rows.push({
        kind: 'tableLabel',
        depth: labelDepth,
        tableName: node.tableName,
        tableRows: node.tableRows,
        color: tableColor,
      });

      if (node.columns.length === 0) {
        // countlinks-style: no target column on this hop. The label stands
        // alone; recursion stops here regardless of node.children.
        continue;
      }

      for (const col of node.columns) {
        const colIdx = rows.length;
        rows.push({
          kind: 'col',
          depth: labelDepth,
          iconClass: COL_ICONS[col.type] || 'dtable-icon-single-line-text',
          name: col.name,
          edge: 'traversal',
          parentIdx,
          edgeColor: tableColor,
          tintColor: tableColor,
          targetTableName: node.tableName,
        });
        if (node.children && node.children.length > 0) {
          walk(node.children, colIdx, labelDepth);
        }
      }
    }
  }

  walk(chain, firstTraversalParent, firstTraversalParentDepth);

  return rows;
}

const dotX = (depth: number): number => depth * INDENT + INDENT;

export const ChainGraph: React.FC<ChainGraphProps> = ({ chain, rootColumn }) => {
  const colorMap = useContext(TableColorContext);
  const rows = buildRows(chain, rootColumn, colorMap);
  if (rows.length === 0) return null;

  // Layout pass — assign y per row, dotY for col rows.
  const layout: Array<{ y: number; height: number; dotY?: number }> = [];
  let y = 0;
  for (const row of rows) {
    const height = ROW_H;
    const dotY = row.kind === 'col' ? y + ROW_H / 2 : undefined;
    layout.push({ y, height, dotY });
    y += height + GAP;
  }
  const totalH = y - GAP;

  const maxDepth = Math.max(...rows.map((r) => r.depth));
  const svgW = dotX(maxDepth) + DOT_R + 3;

  const svgElements: React.ReactNode[] = [];

  // Curves first, dots second so dots paint over curve ends cleanly.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind !== 'col' || row.edge === 'none') continue;

    const cx = dotX(row.depth);
    const cy = layout[i].dotY!;

    // Top-level rows (parentIdx === null but edge !== 'none') hang from a
    // virtual parent placed above the SVG, one indent to the left of the
    // row's own dot. With overflow: visible the curve renders above y=0.
    let lx: number;
    let verticalStartY: number;
    if (row.parentIdx === null) {
      lx = Math.max(0, cx - INDENT);
      verticalStartY = -ROW_H / 2 + DOT_R + 2;
    } else {
      const parent = rows[row.parentIdx] as ColRow;
      const parentLayout = layout[row.parentIdx];
      if (parentLayout.dotY === undefined) continue;
      lx = dotX(parent.depth);
      verticalStartY = parentLayout.dotY + DOT_R + 2;
    }

    const curveStartY = cy - CURVE_R;
    const stroke = row.edge === 'reference' ? REFERENCE_STROKE : row.edgeColor || HEAD_RING;
    const strokeWidth = row.edge === 'reference' ? REFERENCE_WIDTH : TRAVERSAL_WIDTH;
    const strokeOpacity = row.edge === 'reference' ? 1 : TRAVERSAL_OPACITY;

    svgElements.push(
      <path
        key={`p-${i}`}
        d={`M ${lx} ${verticalStartY} L ${lx} ${curveStartY} Q ${lx} ${cy} ${lx + CURVE_R} ${cy} L ${cx - DOT_R - 2} ${cy}`}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeOpacity={strokeOpacity}
      />
    );
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.kind !== 'col') continue;
    const cx = dotX(row.depth);
    const cy = layout[i].dotY!;
    const ringColor =
      row.edge === 'reference'
        ? REFERENCE_STROKE
        : row.edge === 'traversal'
          ? row.tintColor || HEAD_RING
          : HEAD_RING;
    svgElements.push(
      <circle
        key={`d-${i}`}
        cx={cx}
        cy={cy}
        r={DOT_R}
        fill="#fff"
        stroke={ringColor}
        strokeWidth={2}
      />
    );
  }

  // Absolute positioning per row keeps the dot↔text gap constant: each row's
  // text starts at (its own dot x) + DOT_R + TEXT_GAP. Deeper rows naturally
  // get more left padding, so chain depth is reflected in text indent the
  // same way it is in dot position. The SVG is layered behind the rows and
  // takes pointer-events: none so it never blocks interactions.
  const SVG_LEFT = 20; // first vertical (SVG x=0) lands at this absolute x
  const TEXT_GAP = 6;
  return (
    <div style={{ position: 'relative', marginTop: 4, height: totalH }}>
      <svg
        width={svgW}
        height={totalH}
        style={{
          position: 'absolute',
          left: SVG_LEFT,
          top: 0,
          overflow: 'visible',
          pointerEvents: 'none',
        }}>
        {svgElements}
      </svg>
      {rows.map((row, i) => {
        // Col text sits TEXT_GAP px right of its own dot. Table labels
        // anchor at the child column's dot — i.e., (DOT_R + TEXT_GAP) ≈ 10
        // pixels to the left of the col text — so each hop reads as
        // table > column with a tight, dot-aligned visual.
        const left =
          row.kind === 'tableLabel'
            ? SVG_LEFT + dotX(row.depth)
            : SVG_LEFT + dotX(row.depth) + DOT_R + TEXT_GAP;
        const baseStyle: React.CSSProperties = {
          position: 'absolute',
          top: layout[i].y,
          left,
          height: ROW_H,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          lineHeight: `${ROW_H}px`,
        };
        if (row.kind === 'tableLabel') {
          return (
            <div key={i} style={{ ...baseStyle, fontSize: 11 }}>
              <span
                style={{
                  color: '#aaa',
                  textTransform: 'lowercase',
                }}>
                {intl.get('common.table').d('Table')}
              </span>
              <span style={{ fontWeight: 600, color: row.color }}>{row.tableName}</span>
              <span style={{ color: '#888' }}>
                ({row.tableRows} {intl.get('common.rows').d('rows')})
              </span>
            </div>
          );
        }
        const tint = row.edge === 'traversal' ? row.tintColor || '#555' : '#555';
        return (
          <div key={i} style={{ ...baseStyle, fontSize: 12, color: tint }}>
            <i
              className={`dtable-font ${row.iconClass}`}
              style={{ fontSize: 12, color: '#aaa' }}
            />
            <span>{row.name}</span>
          </div>
        );
      })}
    </div>
  );
};

export default ChainGraph;
