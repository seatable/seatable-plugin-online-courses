import React from 'react';
import intl from 'react-intl-universal';
import { ChainNode } from '../../../utils/custom-interfaces/AuditTypes';

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

const DEPTH_COLORS = ['#17a2b8', '#6f42c1', '#e67e22', '#28a745'];

interface FlatRow {
  node: ChainNode;
  depth: number;
  isLast: boolean;
}

function flattenChain(nodes: ChainNode[], depth: number = 0): FlatRow[] {
  const rows: FlatRow[] = [];
  nodes.forEach((node, i) => {
    rows.push({ node, depth, isLast: i === nodes.length - 1 });
    const children = node.children || [];
    if (children.length > 0) {
      rows.push(...flattenChain(children, depth + 1));
    }
  });
  return rows;
}

const ROW_H = 22;
const COL_LINE_H = 20;
const GAP = 6;
const INDENT = 18;
const DOT_R = 4;
const CURVE_R = 6;

interface RowLayout {
  y: number;
  dotY: number;
  height: number;
  depth: number;
  isLast: boolean;
  node: ChainNode;
}

export const ChainGraph: React.FC<{ chain: ChainNode[] }> = ({ chain }) => {
  if (chain.length === 0) return null;

  const rows = flattenChain(chain);

  const layout: RowLayout[] = [];
  let y = 0;
  for (const row of rows) {
    const cols = (row.node.columns || []).length;
    const contentH = ROW_H + cols * COL_LINE_H;
    const dotY = y + ROW_H / 2;
    layout.push({
      y,
      dotY,
      height: contentH,
      depth: row.depth,
      isLast: row.isLast,
      node: row.node,
    });
    y += contentH + GAP;
  }
  const totalH = y - GAP;

  const dotX = (depth: number) => depth * INDENT + INDENT;

  const maxDepth = Math.max(...layout.map((r) => r.depth));
  const svgW = dotX(maxDepth) + DOT_R + 3;

  const svgElements: React.ReactNode[] = [];

  for (let i = 0; i < layout.length; i++) {
    const row = layout[i];
    if (row.isLast) {
      const children = row.node.children || [];
      if (children.length > 0 && i + 1 < layout.length) {
        const childRow = layout[i + 1];
        const childColor = DEPTH_COLORS[Math.min(childRow.depth, DEPTH_COLORS.length - 1)];
        const x = dotX(row.depth);
        svgElements.push(
          <line
            key={`v-child-${i}`}
            x1={x}
            y1={row.dotY + DOT_R + 2}
            x2={x}
            y2={childRow.y}
            stroke={childColor}
            strokeWidth={2}
            strokeOpacity={0.5}
          />
        );
      }
      continue;
    }
    for (let j = i + 1; j < layout.length; j++) {
      if (layout[j].depth === row.depth) {
        const color = DEPTH_COLORS[Math.min(row.depth, DEPTH_COLORS.length - 1)];
        const x = dotX(row.depth);
        svgElements.push(
          <line
            key={`v-${i}-${j}`}
            x1={x}
            y1={row.dotY}
            x2={x}
            y2={layout[j].dotY}
            stroke={color}
            strokeWidth={2}
            strokeOpacity={0.5}
          />
        );
        const children = row.node.children || [];
        if (children.length > 0 && i + 1 < layout.length && layout[i + 1].depth > row.depth) {
          const childRow = layout[i + 1];
          const childColor = DEPTH_COLORS[Math.min(childRow.depth, DEPTH_COLORS.length - 1)];
          const px = dotX(row.depth);
          svgElements.push(
            <line
              key={`v-child2-${i}`}
              x1={px}
              y1={row.dotY}
              x2={px}
              y2={childRow.y}
              stroke={childColor}
              strokeWidth={2}
              strokeOpacity={0.5}
            />
          );
        }
        break;
      }
      if (layout[j].depth < row.depth) break;
    }
  }

  for (let i = 0; i < layout.length; i++) {
    const row = layout[i];
    const color = DEPTH_COLORS[Math.min(row.depth, DEPTH_COLORS.length - 1)];
    const cx = dotX(row.depth);
    const cy = row.dotY;

    const lx = row.depth > 0 ? dotX(row.depth - 1) : cx - INDENT + 2;
    const ly = row.y;
    const curveEndY = cy;
    const curveStartY = curveEndY - CURVE_R;
    svgElements.push(
      <path
        key={`l-${i}`}
        d={`M ${lx} ${ly} L ${lx} ${curveStartY} Q ${lx} ${curveEndY} ${lx + CURVE_R} ${curveEndY} L ${cx - DOT_R - 2} ${curveEndY}`}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeOpacity={0.5}
      />
    );

    svgElements.push(
      <circle key={`d-${i}`} cx={cx} cy={cy} r={DOT_R} fill="#fff" stroke={color} strokeWidth={2} />
    );
  }

  return (
    <div style={{ display: 'flex', marginTop: 4, gap: 4 }}>
      <svg width={svgW} height={totalH} style={{ flexShrink: 0, overflow: 'visible' }}>
        {svgElements}
      </svg>
      <div style={{ flex: 1 }}>
        {layout.map((row, i) => {
          const columns = row.node.columns || [];
          return (
            <div
              key={i}
              style={{
                height: row.height + (i < layout.length - 1 ? GAP : 0),
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-start',
              }}>
              <div style={{ fontSize: 12, lineHeight: `${ROW_H}px` }}>
                <span style={{ fontWeight: 600, color: '#333' }}>{row.node.tableName}</span>
                <span style={{ color: '#888', marginLeft: 4 }}>
                  ({row.node.tableRows} {intl.get('common.rows').d('rows')})
                </span>
              </div>
              {columns.map((col, ci) => {
                const colIcon = COL_ICONS[col.type] || 'dtable-icon-single-line-text';
                return (
                  <div
                    key={ci}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 12,
                      color: '#555',
                      lineHeight: `${COL_LINE_H}px`,
                      paddingLeft: 10,
                    }}>
                    <i
                      className={`dtable-font ${colIcon}`}
                      style={{ fontSize: 12, color: '#aaa' }}
                    />
                    <span>{col.name}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ChainGraph;
