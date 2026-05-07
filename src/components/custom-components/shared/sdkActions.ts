// Direct-mutation helpers for the SeaTable plugin SDK. These bypass the test-case
// workflow and act on the original base immediately. Callers are responsible for
// confirming destructive intent and refreshing any affected audit state.

export function deleteColumnDirect(tableName: string, columnName: string): boolean {
  try {
    const dtableSDK = (window as any).dtableSDK;
    const tables = dtableSDK.getTables();
    const tableIndex = tables.findIndex((t: any) => t.name === tableName);
    if (tableIndex === -1) return false;
    const table = tables[tableIndex];
    const column = table.columns.find((c: any) => c.name === columnName);
    if (!column) return false;
    dtableSDK.dtableStore.deleteColumn(tableIndex, column.key, column);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to delete column:', err);
    return false;
  }
}

export function deleteViewDirect(tableName: string, viewName: string): boolean {
  try {
    (window as any).dtableSDK.deleteView(tableName, viewName);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Failed to delete view:', err);
    return false;
  }
}
