import { createContext, useContext } from 'react';

// 8-color palette for chain-graph traversal curves and target-table labels.
// Default assignment is hash-based (cross-base stable, but link-adjacent tables
// can collide). When a TableColorMap is provided via TableColorContext, lookups
// use the map first — that map is built once per base from the full link
// structure via Welsh-Powell greedy graph coloring (buildTableColorMap below)
// so directly link-adjacent tables are guaranteed to differ, up to the palette
// size of 8. Beyond 8 mutually-linked tables, the densest spot wraps around to
// the hash fallback; the table label still names the table.
//
// These hex values are placeholders to be matched to SeaTable theming later.
export const TABLE_PALETTE: readonly string[] = [
  '#46a1fd',
  '#4ecccb',
  '#addf84',
  '#59cb74',
  '#9f8cf1',
  '#dc82d2',
  '#eaa775',
  '#f4667c',
];

export function colorForTable(tableName: string): string {
  let h = 0;
  for (let i = 0; i < tableName.length; i++) {
    h = ((h << 5) - h + tableName.charCodeAt(i)) | 0;
  }
  return TABLE_PALETTE[Math.abs(h) % TABLE_PALETTE.length];
}

export type TableColorMap = Map<string, string>;

export const TableColorContext = createContext<TableColorMap | null>(null);

export function useTableColor(tableName: string): string {
  const map = useContext(TableColorContext);
  if (map) {
    const c = map.get(tableName);
    if (c) return c;
  }
  return colorForTable(tableName);
}

// Walk every table's columns once, collecting undirected link adjacency keyed
// by table name (the same handle ChainGraph uses). Self-links don't constrain
// coloring — a table is always the same color as itself — so they're skipped.
export function extractLinkAdjacency(allTables: any[]): Map<string, Set<string>> {
  const nameById = new Map<string, string>();
  for (const t of allTables) {
    if (t?._id && t?.name) nameById.set(t._id, t.name);
  }

  const adjacency = new Map<string, Set<string>>();
  const ensure = (name: string): Set<string> => {
    let set = adjacency.get(name);
    if (!set) {
      set = new Set();
      adjacency.set(name, set);
    }
    return set;
  };

  for (const t of allTables) {
    if (!t?.name) continue;
    ensure(t.name);
    for (const col of t.columns ?? []) {
      if (col?.type !== 'link' || !col?.data) continue;
      const a = col.data.table_id;
      const b = col.data.other_table_id;
      const targetId = a === t._id ? b : a;
      const targetName = nameById.get(targetId);
      if (!targetName || targetName === t.name) continue;
      ensure(t.name).add(targetName);
      ensure(targetName).add(t.name);
    }
  }
  return adjacency;
}

// Welsh-Powell greedy coloring with a distance-2 soft preference.
//
// Process tables in descending degree order (ties broken by name for
// determinism). For each table we compute two forbidden sets:
//   - HARD: colors of directly-linked neighbors. Must not collide.
//   - SOFT: colors of 2-hop neighbors (neighbors of neighbors, minus self and
//     direct neighbors). Avoid if possible.
// Then we pick the lowest-index palette color avoiding both; if none fits, we
// relax to "avoid hard only"; if even that fails (palette exhausted by direct
// neighborhood), we fall back to the name hash. So in a chain A → B → C, A and
// C only share a color when there is genuinely no other choice in the palette.
export function buildTableColorMap(
  adjacency: Map<string, Set<string>>,
  tableNames: string[]
): TableColorMap {
  const ordered = [...tableNames].sort((a, b) => {
    const da = adjacency.get(a)?.size ?? 0;
    const db = adjacency.get(b)?.size ?? 0;
    if (db !== da) return db - da;
    return a.localeCompare(b);
  });

  const result: TableColorMap = new Map();
  for (const name of ordered) {
    const hardForbidden = new Set<string>();
    const softForbidden = new Set<string>();
    const neighbors = adjacency.get(name);
    if (neighbors) {
      neighbors.forEach((n1) => {
        const c1 = result.get(n1);
        if (c1) hardForbidden.add(c1);
        const n2set = adjacency.get(n1);
        if (!n2set) return;
        n2set.forEach((n2) => {
          if (n2 === name || neighbors.has(n2)) return;
          const c2 = result.get(n2);
          if (c2) softForbidden.add(c2);
        });
      });
    }

    let chosen: string | undefined;
    for (const c of TABLE_PALETTE) {
      if (!hardForbidden.has(c) && !softForbidden.has(c)) {
        chosen = c;
        break;
      }
    }
    if (chosen === undefined) {
      for (const c of TABLE_PALETTE) {
        if (!hardForbidden.has(c)) {
          chosen = c;
          break;
        }
      }
    }
    result.set(name, chosen ?? colorForTable(name));
  }
  return result;
}
