// 8-color palette for chain-graph traversal curves and target-table labels.
// Hashing is by table name (the only stable handle exposed on ChainNode);
// collisions inside a single chain are disambiguated by the textual table
// label per the chain-graph spec.
//
// These hex values are placeholders to be matched to SeaTable theming later.
export const TABLE_PALETTE: readonly string[] = [
  '#17a2b8',
  '#6f42c1',
  '#e67e22',
  '#28a745',
  '#dc3545',
  '#fd7e14',
  '#20c997',
  '#6610f2',
];

export function colorForTable(tableName: string): string {
  let h = 0;
  for (let i = 0; i < tableName.length; i++) {
    h = ((h << 5) - h + tableName.charCodeAt(i)) | 0;
  }
  return TABLE_PALETTE[Math.abs(h) % TABLE_PALETTE.length];
}
