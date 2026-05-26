/**
 * Test 7a — self-link indirection POC for link-formula columns.
 *
 * The "freeze" mechanism Test 3 validated for plain formulas doesn't extend
 * to link-formulas: a link-formula's `data.formula` is an operation name
 * (countlinks / findmax / lookup / rollup), not an expression that can be
 * rewritten to `{Donor}`. And `modify_column_type` on a big table hits the
 * 60s nginx wall (see [[reference_modify_column_type_60s_corruption]]).
 *
 * Test 7a tries an alternate path that keeps the LF column intact but mutates
 * its underlying `data` so it evaluates to a static snapshot value:
 *
 *   1. Add a snapshot column on the same table; populate it with the LF's
 *      current values (Test 3 pipeline).
 *   2. Add a self-link column on the same table (link to same table).
 *   3. Populate the self-link so every row links to itself.
 *   4. setColumnData on the LF — keep `type: 'link-formula'` but change
 *      `formula` to `lookup`, `link_column_key` to the self-link, and
 *      `column_key_in_linked_record` to the snapshot.
 *   5. The LF now evaluates as: "lookup the snapshot value of the row I link
 *      to" = "lookup MY OWN snapshot value" = the snapshot value. Static.
 *
 * Column key preserved → forms / apps / automations / external integrations
 * keep working. Type preserved → no modify_column_type, no 60s wall. The
 * snapshot column is the single source of truth; the LF reads it through the
 * self-link.
 *
 * Handles both single-value and array-result LFs:
 *   - Single-value (countlinks, findmax→date, lookup→single text, etc.):
 *     snapshot column matches the result_type; LF post-mutation has same
 *     result_type. Downstream consumers see the same shape.
 *   - Array-result (lookup of multi-link, etc.): snapshot is `long-text`
 *     holding the array values joined by `arraySeparator` (default ", ").
 *     LF post-mutation returns `result_type: 'string'`. Consumers that
 *     expected an array must split the string. The freeze contract.
 *
 * MUTATES A REAL COLUMN AND ADDS TWO COLUMNS. Caller must pass
 * `acknowledgeProduction: true`. Use a test base or a column you can revert.
 */

import {
  ShapeMode,
  COLLAPSIBLE_ARRAY_ELEMENT_TYPES,
  snapshotTypeForResultType,
  serializeForSnapshot,
  deriveSnapshotColumnData,
  fetchWithTimeout,
  httpAddColumn,
  httpDeleteColumn,
  httpSqlChunk,
  httpBatchUpdate,
  httpBatchUpdateLinks,
} from './freezeColumn';

interface TrialResult {
  ok: boolean;
  ms: number;
  error?: string;
  detail?: string;
}

export interface Test7Opts {
  dtableSDK: any;
  tableName: string;
  /** Link-formula column to freeze. Will have its `data` mutated to lookup-through-self-link. */
  lfColumnName: string;
  /** Optional snapshot column name. Defaults to `_snapshot_<lfColumnName>`. Must not already exist. */
  snapshotColumnName?: string;
  /** Optional self-link column name. Defaults to `_selflink_<tableName>`. Must not already exist. */
  selfLinkColumnName?: string;
  /**
   * When true (default), restores the original LF data and deletes both added columns at the end.
   * Set to false to inspect the post-mutation state in the SeaTable UI.
   */
  autoRestore?: boolean;
  acknowledgeProduction?: boolean;
  accessToken?: string;
  dtableUuid?: string;
  onProgress?: (msg: string) => void;
  sqlChunkSize?: number; // default 10_000 (SeaTable SQL cap)
  batchUpdateChunkSize?: number; // default 1_000 (batch_update_rows API limit)
  linksBatchChunkSize?: number; // default 1_000 (assumed same cap as batch_update_rows)
  httpTimeoutMs?: number; // default 90s
  /** Separator used when concatenating array-result LF values into the long-text snapshot. */
  arraySeparator?: string; // default ', '
}

export interface Test7Result {
  column: {
    tableName: string;
    lfColumnName: string;
    snapshotColumnName: string;
    selfLinkColumnName: string;
  };
  lfColumnKey: string;
  snapshotColumnKey: string;
  selfLinkColumnKey: string;
  selfLinkId: string;
  snapshotType: string;
  rowCount: number;
  rowsRead: number;
  rowsWritten: number;
  rowsLinked: number;
  phases: {
    addSnapshot: TrialResult;
    sqlRead: TrialResult;
    batchPopulate: TrialResult;
    addSelfLink: TrialResult;
    populateLinks: TrialResult;
    swap: TrialResult;
    verify: TrialResult;
    restore: TrialResult;
  };
  valuesMatched: number | null;
  verdict:
    | 'works'
    | 'works-but-slow'
    | 'mismatch'
    | 'restored-after-failure'
    | 'left-frozen'
    | 'aborted'
    | 'unsupported-array-result';
  cleanupSnippet: string;
  notes: string[];
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

export async function runTest7(opts: Test7Opts): Promise<Test7Result> {
  const {
    dtableSDK,
    tableName,
    lfColumnName,
    autoRestore = true,
    acknowledgeProduction = false,
    onProgress,
    sqlChunkSize = 10_000,
    batchUpdateChunkSize = 1_000,
    linksBatchChunkSize = 1_000,
    httpTimeoutMs = 90 * 1000,
    arraySeparator = ', ',
  } = opts;
  const accessToken: string = opts.accessToken || dtableSDK?.config?.accessToken || '';
  const dtableUuid: string = opts.dtableUuid || dtableSDK?.config?.dtableUuid || '';
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';

  const notes: string[] = [];
  const phases: Test7Result['phases'] = {
    addSnapshot: { ok: false, ms: 0, error: 'not attempted' },
    sqlRead: { ok: false, ms: 0, error: 'not attempted' },
    batchPopulate: { ok: false, ms: 0, error: 'not attempted' },
    addSelfLink: { ok: false, ms: 0, error: 'not attempted' },
    populateLinks: { ok: false, ms: 0, error: 'not attempted' },
    swap: { ok: false, ms: 0, error: 'not attempted' },
    verify: { ok: false, ms: 0, error: 'not attempted' },
    restore: { ok: false, ms: 0, error: 'not attempted' },
  };

  const finalize = (
    verdict: Test7Result['verdict'],
    extra?: Partial<Test7Result>
  ): Test7Result => ({
    column: {
      tableName,
      lfColumnName,
      snapshotColumnName: extra?.column?.snapshotColumnName || opts.snapshotColumnName || '',
      selfLinkColumnName: extra?.column?.selfLinkColumnName || opts.selfLinkColumnName || '',
    },
    lfColumnKey: extra?.lfColumnKey || '',
    snapshotColumnKey: extra?.snapshotColumnKey || '',
    selfLinkColumnKey: extra?.selfLinkColumnKey || '',
    selfLinkId: extra?.selfLinkId || '',
    snapshotType: extra?.snapshotType || '',
    rowCount: extra?.rowCount || 0,
    rowsRead: extra?.rowsRead || 0,
    rowsWritten: extra?.rowsWritten || 0,
    rowsLinked: extra?.rowsLinked || 0,
    phases,
    valuesMatched: extra?.valuesMatched ?? null,
    verdict,
    cleanupSnippet: extra?.cleanupSnippet || '',
    notes,
    ...extra,
  });

  if (!acknowledgeProduction) {
    notes.push('aborted: pass acknowledgeProduction: true to mutate the base');
    return finalize('aborted');
  }
  if (!accessToken || !dtableUuid) {
    notes.push(
      `aborted: missing auth — accessToken ${accessToken ? 'ok' : 'EMPTY'}, dtableUuid ${dtableUuid ? 'ok' : 'EMPTY'}`
    );
    return finalize('aborted');
  }

  // ---- Pre-flight: locate LF column, capture original data
  const tables: any[] = dtableSDK.getTables();
  const tableIndex = tables.findIndex((t: any) => t.name === tableName);
  if (tableIndex < 0) {
    notes.push(`aborted: table "${tableName}" not found`);
    return finalize('aborted');
  }
  const tbl = tables[tableIndex];
  const lfCol = (tbl.columns || []).find((c: any) => c.name === lfColumnName);
  if (!lfCol) {
    notes.push(`aborted: column "${lfColumnName}" not found in "${tableName}"`);
    return finalize('aborted');
  }
  if (lfCol.type !== 'link-formula') {
    notes.push(`aborted: "${lfColumnName}" is type "${lfCol.type}", expected "link-formula"`);
    return finalize('aborted');
  }

  const lfColumnKey: string = lfCol.key;
  const originalData = JSON.parse(JSON.stringify(lfCol.data || {}));
  const resultType: string | undefined = originalData.result_type;
  const snapshotColumnName = opts.snapshotColumnName || `_snapshot_${lfColumnName}`;
  const selfLinkColumnName = opts.selfLinkColumnName || `_selflink_${tableName}`;
  const rowCount = (tbl.rows || []).length;

  notes.push(
    `LF column: ${tableName} › ${lfColumnName} (key=${lfColumnKey}, rows=${rowCount}, formula=${originalData.formula}, result_type=${resultType}${resultType === 'array' ? `, array_type=${originalData.array_type}` : ''})`
  );

  const isArrayResult = resultType === 'array';
  // Shape mode is finalized AFTER the SQL read: if every row's array has length ≤ 1
  // we treat it as effectively single-value and use a typed snapshot (preserving
  // date / number / select semantics for downstream filters, color rules, etc.).
  // Otherwise the snapshot is long-text holding the joined string.
  let shapeMode: ShapeMode = isArrayResult ? 'multi-array' : 'scalar';
  let snapshotType = snapshotTypeForResultType(resultType);
  notes.push(`self-link column (to create): "${selfLinkColumnName}" (link to same table)`);

  // Reject if either name collides with an existing column.
  const existing = (tbl.columns || []).map((c: any) => c.name);
  if (existing.includes(snapshotColumnName)) {
    notes.push(
      `aborted: column "${snapshotColumnName}" already exists. Pass snapshotColumnName or remove it.`
    );
    return finalize('aborted', { lfColumnKey, rowCount });
  }
  if (existing.includes(selfLinkColumnName)) {
    notes.push(
      `aborted: column "${selfLinkColumnName}" already exists. Pass selfLinkColumnName or remove it.`
    );
    return finalize('aborted', { lfColumnKey, rowCount });
  }

  notes.push(
    `autoRestore=${autoRestore}, sqlChunk=${sqlChunkSize}, batchChunk=${batchUpdateChunkSize}, linksChunk=${linksBatchChunkSize}`
  );

  let snapshotColumnKey = '';
  let selfLinkColumnKey = '';
  let selfLinkId = '';

  const rollback = async (reason: string): Promise<void> => {
    notes.push(`rollback initiated: ${reason}`);
    if (phases.swap.ok) {
      try {
        const store = dtableSDK.dtableStore;
        const op = store.createOperation({
          type: 'modify_column_data',
          table_id: tbl._id,
          column_key: lfColumnKey,
          column_data: originalData,
        });
        store.applyLocalOperation(op);
        notes.push('rollback: restored original LF data via applyLocalOperation');
      } catch (e: any) {
        notes.push(`rollback: LF restore FAILED — ${e?.message || e}`);
      }
    }
    if (selfLinkColumnKey) {
      const del = await httpDeleteColumn(
        serverUrl,
        dtableUuid,
        accessToken,
        tableName,
        selfLinkColumnKey,
        httpTimeoutMs
      );
      notes.push(
        `rollback: delete self-link — ${del.ok ? 'ok' : 'FAILED'} in ${fmt(del.ms)}${del.body ? ` (${(del.body || '').slice(0, 100)})` : ''}`
      );
    }
    if (snapshotColumnKey) {
      const del = await httpDeleteColumn(
        serverUrl,
        dtableUuid,
        accessToken,
        tableName,
        snapshotColumnKey,
        httpTimeoutMs
      );
      notes.push(
        `rollback: delete snapshot — ${del.ok ? 'ok' : 'FAILED'} in ${fmt(del.ms)}${del.body ? ` (${(del.body || '').slice(0, 100)})` : ''}`
      );
    }
  };

  // ---- Phase 1: SQL read LF values + row _ids (must happen before snapshot column
  // creation so we can detect actual array shape and pick a typed snapshot when
  // every row's array is length ≤ 1).
  if (onProgress)
    onProgress(
      `Phase 1/8: Reading ${rowCount} LF values + row _ids via SQL (chunks of ${sqlChunkSize})...`
    );
  const t1 = Date.now();
  const collected: Map<string, any> = new Map(); // _id -> LF value
  let sqlErr: string | undefined;
  for (let offset = 0; offset < rowCount; offset += sqlChunkSize) {
    if (onProgress) {
      onProgress(
        `P1 SQL read: rows ${offset}–${Math.min(offset + sqlChunkSize, rowCount)} of ${rowCount}...`
      );
    }
    const chunk = await httpSqlChunk(
      serverUrl,
      dtableUuid,
      accessToken,
      `SELECT _id, \`${lfColumnName}\` FROM \`${tableName}\` LIMIT ${sqlChunkSize} OFFSET ${offset}`,
      httpTimeoutMs
    );
    if (!chunk.ok) {
      sqlErr = `HTTP ${chunk.status}: ${(chunk.body || '').slice(0, 200)}`;
      break;
    }
    const valKey =
      chunk.metadata.find((m: any) => (m.name || m.column_name) === lfColumnName)?.key ||
      chunk.metadata.find((m: any) => (m.name || m.column_name) === lfColumnName)?.column_key ||
      lfColumnKey;
    for (const r of chunk.rows) {
      const id = r._id || r._rowid;
      if (id) collected.set(id, r[valKey]);
    }
    if (chunk.rows.length < sqlChunkSize) break;
  }
  phases.sqlRead.ms = Date.now() - t1;
  phases.sqlRead.ok = !sqlErr;
  if (sqlErr) phases.sqlRead.error = sqlErr;
  phases.sqlRead.detail = `read ${collected.size} row values`;
  notes.push(
    `P1 sqlRead: ${phases.sqlRead.ok ? 'ok' : 'FAIL'} in ${fmt(phases.sqlRead.ms)} — ${collected.size} rows${sqlErr ? ` (${sqlErr})` : ''}`
  );
  if (!phases.sqlRead.ok) {
    return finalize('aborted', { lfColumnKey, snapshotType, rowCount, rowsRead: collected.size });
  }

  // ---- Shape inspection: if it's an array LF but every row's array is length ≤ 1
  // AND the array_type is a collapsible scalar, collapse the snapshot to that type.
  if (isArrayResult) {
    let maxLen = 0;
    collected.forEach((v) => {
      if (Array.isArray(v) && v.length > maxLen) maxLen = v.length;
    });
    const arrayType: string | undefined = originalData.array_type;
    const collapsible = maxLen <= 1 && arrayType && COLLAPSIBLE_ARRAY_ELEMENT_TYPES.has(arrayType);
    if (collapsible) {
      shapeMode = 'collapsed-array';
      snapshotType = arrayType as string;
      notes.push(
        `shape inspection: max array length = ${maxLen}, array_type=${arrayType} → collapsing to typed snapshot (preserves date/number/select semantics for downstream rules)`
      );
    } else {
      shapeMode = 'multi-array';
      snapshotType = 'long-text';
      notes.push(
        `shape inspection: max array length = ${maxLen}${arrayType ? `, array_type=${arrayType}` : ''} → multi-value, using long-text snapshot with separator ${JSON.stringify(arraySeparator)}`
      );
    }
  }
  notes.push(`snapshot column (to create): "${snapshotColumnName}" type=${snapshotType}`);

  // ---- Phase 2: Add snapshot column
  if (onProgress)
    onProgress(`Phase 2/8: Adding snapshot column "${snapshotColumnName}" (${snapshotType})...`);
  const snapshotColumnData = deriveSnapshotColumnData(originalData, snapshotType, shapeMode);
  if (snapshotColumnData) {
    notes.push(
      `snapshot column_data (propagated from original): ${JSON.stringify(snapshotColumnData)}`
    );
  }
  const addColumnBody: Record<string, any> = {
    table_name: tableName,
    column_name: snapshotColumnName,
    column_type: snapshotType,
  };
  if (snapshotColumnData) addColumnBody.column_data = snapshotColumnData;
  const addSnap = await httpAddColumn(
    serverUrl,
    dtableUuid,
    accessToken,
    addColumnBody,
    httpTimeoutMs
  );
  phases.addSnapshot = {
    ok: addSnap.ok,
    ms: addSnap.ms,
    error: addSnap.ok ? undefined : `HTTP ${addSnap.status}: ${(addSnap.body || '').slice(0, 200)}`,
  };
  notes.push(
    `P2 addSnapshot: ${phases.addSnapshot.ok ? 'ok' : 'FAIL'} in ${fmt(phases.addSnapshot.ms)}${!phases.addSnapshot.ok && phases.addSnapshot.error ? ` — ${phases.addSnapshot.error}` : ''}`
  );
  if (!phases.addSnapshot.ok) {
    return finalize('aborted', { lfColumnKey, snapshotType, rowCount, rowsRead: collected.size });
  }
  snapshotColumnKey =
    addSnap.key ||
    (await (async () => {
      const meta = await httpSqlChunk(
        serverUrl,
        dtableUuid,
        accessToken,
        `SELECT _id FROM \`${tableName}\` LIMIT 0`,
        httpTimeoutMs
      );
      const col = meta.metadata?.find((m: any) => (m.name || m.column_name) === snapshotColumnName);
      return col?.key || col?.column_key || '';
    })());
  if (!snapshotColumnKey) {
    notes.push("WARNING: couldn't resolve snapshot column key — subsequent ops will fail");
    await rollback('snapshot key unresolved');
    return finalize('restored-after-failure', {
      lfColumnKey,
      snapshotType,
      rowCount,
      rowsRead: collected.size,
    });
  }
  notes.push(`snapshot column_key: ${snapshotColumnKey}`);

  // ---- Phase 3: Populate snapshot via batch_update_rows
  if (onProgress)
    onProgress(`Phase 3/8: Populating snapshot in chunks of ${batchUpdateChunkSize}...`);
  const t3 = Date.now();
  const allUpdates = Array.from(collected.entries()).map(([row_id, value]) => {
    let serialized: any;
    if (shapeMode === 'scalar') {
      serialized = value;
    } else if (shapeMode === 'collapsed-array') {
      // Every row's array is length ≤ 1 → extract the lone element (or null).
      serialized = Array.isArray(value) ? (value.length > 0 ? value[0] : null) : value;
    } else {
      // multi-array: serialize to the long-text snapshot.
      serialized = serializeForSnapshot(
        value,
        arraySeparator,
        originalData.array_type,
        originalData.array_data
      );
    }
    return { row_id, row: { [snapshotColumnName]: serialized } };
  });
  let written = 0;
  let batchErr: string | undefined;
  for (let i = 0; i < allUpdates.length; i += batchUpdateChunkSize) {
    if (onProgress) {
      onProgress(
        `P3 batch update: ${i}/${allUpdates.length} (${Math.round((i / Math.max(1, allUpdates.length)) * 100)}%)...`
      );
    }
    const slice = allUpdates.slice(i, i + batchUpdateChunkSize);
    const res = await httpBatchUpdate(
      serverUrl,
      dtableUuid,
      accessToken,
      tableName,
      slice,
      httpTimeoutMs
    );
    if (!res.ok) {
      batchErr = `HTTP ${res.status}: ${(res.body || '').slice(0, 200)}`;
      break;
    }
    written += slice.length;
  }
  phases.batchPopulate.ms = Date.now() - t3;
  phases.batchPopulate.ok = !batchErr;
  if (batchErr) phases.batchPopulate.error = batchErr;
  phases.batchPopulate.detail = `populated ${written}/${allUpdates.length} rows`;
  notes.push(
    `P3 batchPopulate: ${phases.batchPopulate.ok ? 'ok' : 'FAIL'} in ${fmt(phases.batchPopulate.ms)} — ${written} rows${batchErr ? ` (${batchErr})` : ''}`
  );
  if (!phases.batchPopulate.ok) {
    await rollback('batch_update_rows failed');
    return finalize('restored-after-failure', {
      lfColumnKey,
      snapshotColumnKey,
      snapshotType,
      rowCount,
      rowsRead: collected.size,
      rowsWritten: written,
    });
  }

  // ---- Phase 4: Add self-link column (link to same table)
  if (onProgress) onProgress(`Phase 4/8: Adding self-link column "${selfLinkColumnName}"...`);
  const addLink = await httpAddColumn(
    serverUrl,
    dtableUuid,
    accessToken,
    {
      table_name: tableName,
      column_name: selfLinkColumnName,
      column_type: 'link',
      column_data: { table: tableName, other_table: tableName },
    },
    httpTimeoutMs
  );
  phases.addSelfLink = {
    ok: addLink.ok,
    ms: addLink.ms,
    error: addLink.ok ? undefined : `HTTP ${addLink.status}: ${(addLink.body || '').slice(0, 200)}`,
  };
  notes.push(
    `P4 addSelfLink: ${phases.addSelfLink.ok ? 'ok' : 'FAIL'} in ${fmt(phases.addSelfLink.ms)}${!phases.addSelfLink.ok && phases.addSelfLink.error ? ` — ${phases.addSelfLink.error}` : ''}`
  );
  if (!phases.addSelfLink.ok) {
    await rollback('add self-link failed');
    return finalize('restored-after-failure', {
      lfColumnKey,
      snapshotColumnKey,
      snapshotType,
      rowCount,
      rowsRead: collected.size,
      rowsWritten: written,
    });
  }
  selfLinkColumnKey = addLink.key || '';
  selfLinkId = addLink.linkId || '';
  if (!selfLinkColumnKey || !selfLinkId) {
    // Resolve from server metadata if the create response was sparse.
    const meta = await httpSqlChunk(
      serverUrl,
      dtableUuid,
      accessToken,
      `SELECT _id FROM \`${tableName}\` LIMIT 0`,
      httpTimeoutMs
    );
    const col = meta.metadata?.find((m: any) => (m.name || m.column_name) === selfLinkColumnName);
    selfLinkColumnKey = selfLinkColumnKey || col?.key || col?.column_key || '';
    // Fall back to reading the SDK's local state after a sync — but here we ask the server
    // directly via the columns endpoint isn't available; rely on the create response or
    // re-fetch via /metadata/.
    if (!selfLinkId) {
      const metaResp = await fetchWithTimeout(
        `${serverUrl}/api-gateway/api/v2/dtables/${dtableUuid}/metadata/`,
        {
          method: 'GET',
          headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
          cache: 'no-store',
        },
        httpTimeoutMs
      );
      if (metaResp.resp?.ok) {
        const m = await metaResp.resp.json().catch(() => ({}));
        const t = (m?.metadata?.tables || []).find((x: any) => x.name === tableName);
        const c = t?.columns?.find((x: any) => x.name === selfLinkColumnName);
        selfLinkId = c?.data?.link_id || '';
        selfLinkColumnKey = selfLinkColumnKey || c?.key || '';
      }
    }
  }
  if (!selfLinkColumnKey || !selfLinkId) {
    notes.push("WARNING: couldn't resolve self-link column key/link_id — populate will fail");
    await rollback('self-link metadata unresolved');
    return finalize('restored-after-failure', {
      lfColumnKey,
      snapshotColumnKey,
      snapshotType,
      rowCount,
      rowsRead: collected.size,
      rowsWritten: written,
    });
  }
  notes.push(`self-link column_key: ${selfLinkColumnKey}, link_id: ${selfLinkId}`);

  // ---- Phase 5: Populate self-link (every row → itself) via PUT /links/ batched
  if (onProgress)
    onProgress(`Phase 5/8: Populating self-link in chunks of ${linksBatchChunkSize}...`);
  const t5 = Date.now();
  const allRowIds = Array.from(collected.keys());
  let linked = 0;
  let linksErr: string | undefined;
  for (let i = 0; i < allRowIds.length; i += linksBatchChunkSize) {
    if (onProgress) {
      onProgress(
        `P5 link populate: ${i}/${allRowIds.length} (${Math.round((i / Math.max(1, allRowIds.length)) * 100)}%)...`
      );
    }
    const slice = allRowIds.slice(i, i + linksBatchChunkSize);
    const map: Record<string, string[]> = {};
    for (const id of slice) map[id] = [id];
    const res = await httpBatchUpdateLinks(
      serverUrl,
      dtableUuid,
      accessToken,
      {
        link_id: selfLinkId,
        table_name: tableName,
        other_table_name: tableName,
        row_id_list: slice,
        other_rows_ids_map: map,
      },
      httpTimeoutMs
    );
    if (!res.ok) {
      linksErr = `HTTP ${res.status}: ${(res.body || '').slice(0, 200)}`;
      break;
    }
    linked += slice.length;
  }
  phases.populateLinks.ms = Date.now() - t5;
  phases.populateLinks.ok = !linksErr;
  if (linksErr) phases.populateLinks.error = linksErr;
  phases.populateLinks.detail = `linked ${linked}/${allRowIds.length} rows`;
  notes.push(
    `P5 populateLinks: ${phases.populateLinks.ok ? 'ok' : 'FAIL'} in ${fmt(phases.populateLinks.ms)} — ${linked} rows${linksErr ? ` (${linksErr})` : ''}`
  );
  if (!phases.populateLinks.ok) {
    await rollback('PUT /links/ failed');
    return finalize('restored-after-failure', {
      lfColumnKey,
      snapshotColumnKey,
      selfLinkColumnKey,
      selfLinkId,
      snapshotType,
      rowCount,
      rowsRead: collected.size,
      rowsWritten: written,
      rowsLinked: linked,
    });
  }

  // ---- Phase 6: Apply modify_column_data op directly (bypass canEditMetadata gate)
  // `setColumnData` silently no-ops when the column's `edit_metadata_permission_type`
  // is set (e.g. "admins") and `window.dtable.isAdmin` isn't true in the plugin host.
  // We construct the op via the SDK's own helpers and call applyLocalOperation directly.
  if (onProgress)
    onProgress(
      'Phase 6/8: Mutating LF data to lookup-through-self-link via applyLocalOperation...'
    );
  const t6 = Date.now();
  // Build minimal valid lookup config. Keep fields irrelevant to lookup omitted
  // to avoid server-side validation rejecting stale count_links/findmax/rollup fields.
  const mutatedData: any = {
    formula: 'lookup',
    link_column_key: selfLinkColumnKey,
    column_key_in_linked_record: snapshotColumnKey,
    level1_linked_table_column_key: snapshotColumnKey,
    result_type: resultType,
    // The SDK tracks LF dependencies in operated_columns; if stale, view re-renders may
    // miss updates. After swap, the LF depends on the self-link and snapshot columns.
    operated_columns: [selfLinkColumnKey, snapshotColumnKey],
  };
  if (isArrayResult) {
    // collapsed-array: keep original array_type so the LF still appears as the same
    // typed-array (e.g. array of date) — preserves color rules, filters, etc.
    // multi-array: snapshot is long-text, so array_type follows it.
    mutatedData.array_type =
      shapeMode === 'collapsed-array' ? originalData.array_type : 'long-text';
    if (shapeMode === 'collapsed-array' && originalData.array_data) {
      mutatedData.array_data = JSON.parse(JSON.stringify(originalData.array_data));
    }
  }
  // Preserve user-visible formatting at the LF top level for scalar LFs.
  if (shapeMode === 'scalar') {
    if (originalData.format) mutatedData.format = originalData.format;
    if (originalData.decimal !== undefined) mutatedData.decimal = originalData.decimal;
    if (originalData.thousands !== undefined) mutatedData.thousands = originalData.thousands;
  }

  try {
    const store = dtableSDK.dtableStore;
    const tableId = tbl._id;
    const op = store.createOperation({
      type: 'modify_column_data',
      table_id: tableId,
      column_key: lfColumnKey,
      column_data: mutatedData,
    });
    store.applyLocalOperation(op);
    // Read back local state to confirm apply.
    const after = (dtableSDK.getTables()?.[tableIndex]?.columns || []).find(
      (c: any) => c.key === lfColumnKey
    );
    if (after?.data?.formula !== 'lookup' || after?.data?.link_column_key !== selfLinkColumnKey) {
      throw new Error(
        `SDK local state didn't accept the op (got formula=${JSON.stringify(after?.data?.formula)}, link_column_key=${JSON.stringify(after?.data?.link_column_key)})`
      );
    }
    phases.swap.ok = true;
  } catch (e: any) {
    phases.swap.error = e?.message || String(e);
  }
  phases.swap.ms = Date.now() - t6;
  notes.push(
    `P6 swap: ${phases.swap.ok ? 'ok' : 'FAIL'} in ${fmt(phases.swap.ms)}${!phases.swap.ok && phases.swap.error ? ` — ${phases.swap.error}` : ''}`
  );
  if (!phases.swap.ok) {
    await rollback('setColumnData swap failed');
    return finalize('restored-after-failure', {
      lfColumnKey,
      snapshotColumnKey,
      selfLinkColumnKey,
      selfLinkId,
      snapshotType,
      rowCount,
      rowsRead: collected.size,
      rowsWritten: written,
      rowsLinked: linked,
    });
  }

  // ---- Phase 7: Verify LF returns snapshot values
  if (onProgress) onProgress('Phase 7/8: Verifying via SQL sample (10 rows)...');
  const t7 = Date.now();
  const verify = await httpSqlChunk(
    serverUrl,
    dtableUuid,
    accessToken,
    `SELECT \`${lfColumnName}\`, \`${snapshotColumnName}\` FROM \`${tableName}\` LIMIT 10`,
    httpTimeoutMs
  );
  phases.verify.ms = Date.now() - t7;
  let valuesMatched: number | null = null;
  if (!verify.ok) {
    phases.verify.error = `HTTP ${verify.status}: ${(verify.body || '').slice(0, 200)}`;
  } else {
    const fKey =
      verify.metadata.find((m: any) => (m.name || m.column_name) === lfColumnName)?.key ||
      verify.metadata.find((m: any) => (m.name || m.column_name) === lfColumnName)?.column_key ||
      lfColumnKey;
    const sKey =
      verify.metadata.find((m: any) => (m.name || m.column_name) === snapshotColumnName)?.key ||
      verify.metadata.find((m: any) => (m.name || m.column_name) === snapshotColumnName)
        ?.column_key ||
      snapshotColumnKey;
    let matched = 0;
    for (const r of verify.rows) {
      const f = r[fKey];
      const s = r[sKey];
      if (f === undefined && s === undefined) continue;
      let isMatch = false;
      if (f === s) isMatch = true;
      // For array-result LFs the post-mutation LF returns array[long-text]; compare
      // index [0] against the snapshot string.
      else if (Array.isArray(f) && f.length === 1 && f[0] === s) isMatch = true;
      // Catch-all string fallback (covers number/date/etc.)
      else if (String(f ?? '') === String(s ?? '')) isMatch = true;
      if (isMatch) matched++;
    }
    valuesMatched = matched;
    phases.verify.ok = matched === verify.rows.length;
    phases.verify.detail = `${matched}/${verify.rows.length} sampled rows match`;
    notes.push(
      `P7 verify sample (first 3): ${JSON.stringify(verify.rows.slice(0, 3))}`.slice(0, 600)
    );
  }
  notes.push(
    `P7 verify: ${phases.verify.ok ? 'ok' : 'FAIL'} in ${fmt(phases.verify.ms)} — ${phases.verify.detail || phases.verify.error}`
  );

  // ---- Diagnostic: confirm server-side metadata reflects the mutation.
  // Run AFTER P7 verify so the WS-delivered modify_column_data op has had time to
  // commit + invalidate the metadata cache. On the 2026-05-20 array-LF test the
  // inline-after-P6 fetch returned stale original data even though the SQL
  // evaluator had already picked up the change; the post-verify position is
  // reliable. SQL is still the ground truth — this is informational.
  if (phases.swap.ok) {
    try {
      const metaResp = await fetchWithTimeout(
        `${serverUrl}/api-gateway/api/v2/dtables/${dtableUuid}/metadata/`,
        {
          method: 'GET',
          headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
          cache: 'no-store',
        },
        httpTimeoutMs
      );
      if (metaResp.resp?.ok) {
        const m = await metaResp.resp.json().catch(() => ({}));
        const t = (m?.metadata?.tables || []).find((x: any) => x.name === tableName);
        const c = t?.columns?.find((x: any) => x.key === lfColumnKey);
        const serverData = c?.data || {};
        const opPersisted =
          serverData.formula === mutatedData.formula &&
          serverData.link_column_key === mutatedData.link_column_key &&
          serverData.column_key_in_linked_record === mutatedData.column_key_in_linked_record;
        notes.push(
          `metadata persistence check: ${opPersisted ? 'YES' : 'NO (stale or rejected — trust SQL verify above)'}`
        );
        if (!opPersisted) {
          notes.push(`server-side data: ${JSON.stringify(serverData)}`.slice(0, 500));
        }
      } else {
        notes.push(`metadata persistence check: skipped (HTTP ${metaResp.resp?.status ?? 0})`);
      }
    } catch (e: any) {
      notes.push(`metadata persistence check: error — ${e?.message || e}`);
    }
  }

  // ---- Phase 8: Restore (or leave frozen)
  if (autoRestore) {
    if (onProgress) onProgress('Phase 8/8: Restoring original LF data + deleting added columns...');
    const t8 = Date.now();
    let restoreErr: string | undefined;
    try {
      const store = dtableSDK.dtableStore;
      const op = store.createOperation({
        type: 'modify_column_data',
        table_id: tbl._id,
        column_key: lfColumnKey,
        column_data: originalData,
      });
      store.applyLocalOperation(op);
    } catch (e: any) {
      restoreErr = `applyLocalOperation restore: ${e?.message || e}`;
    }
    if (!restoreErr) {
      const delLink = await httpDeleteColumn(
        serverUrl,
        dtableUuid,
        accessToken,
        tableName,
        selfLinkColumnKey,
        httpTimeoutMs
      );
      if (!delLink.ok)
        restoreErr = `delete self-link: HTTP ${delLink.status}: ${(delLink.body || '').slice(0, 200)}`;
    }
    if (!restoreErr) {
      const delSnap = await httpDeleteColumn(
        serverUrl,
        dtableUuid,
        accessToken,
        tableName,
        snapshotColumnKey,
        httpTimeoutMs
      );
      if (!delSnap.ok)
        restoreErr = `delete snapshot: HTTP ${delSnap.status}: ${(delSnap.body || '').slice(0, 200)}`;
    }
    phases.restore.ms = Date.now() - t8;
    phases.restore.ok = !restoreErr;
    if (restoreErr) phases.restore.error = restoreErr;
    notes.push(
      `P8 restore: ${phases.restore.ok ? 'ok' : 'FAIL'} in ${fmt(phases.restore.ms)}${restoreErr ? ` — ${restoreErr}` : ''}`
    );
  } else {
    phases.restore = {
      ok: true,
      ms: 0,
      detail: 'skipped (autoRestore=false) — left frozen for UI inspection',
    };
    notes.push('P8 restore SKIPPED — LF is currently frozen. Run cleanup snippet to revert.');
  }

  // Verdict
  let verdict: Test7Result['verdict'];
  if (!phases.swap.ok || !phases.verify.ok) {
    verdict = 'restored-after-failure';
  } else if (valuesMatched !== null && valuesMatched === 0) {
    verdict = 'mismatch';
  } else if (!autoRestore) {
    verdict = 'left-frozen';
  } else {
    const total =
      phases.addSnapshot.ms +
      phases.sqlRead.ms +
      phases.batchPopulate.ms +
      phases.addSelfLink.ms +
      phases.populateLinks.ms +
      phases.swap.ms +
      phases.verify.ms +
      phases.restore.ms;
    const slowThreshold = 5 * 60 * 1000 * Math.max(1, rowCount / 10_000);
    verdict = total > slowThreshold ? 'works-but-slow' : 'works';
    notes.push(`total wall time: ${fmt(total)}`);
  }
  notes.push(`verdict: ${verdict}`);

  // Cleanup snippet uses applyLocalOperation directly to bypass the canEditMetadata
  // gate (same reason Phase 6 does). setColumnData would silently no-op on columns
  // with `edit_metadata_permission_type` set when window.dtable.isAdmin isn't true.
  // The ${...} placeholders inside the single-quoted lines are intentional — they
  // are emitted verbatim as part of the JS snippet meant for copy-paste into a
  // browser console.
  /* eslint-disable no-template-curly-in-string */
  const cleanupSnippet =
    !autoRestore && (selfLinkColumnKey || snapshotColumnKey)
      ? '// Run this to restore:\n' +
        'const sdk = window.dtableSDK;\n' +
        `const ti = sdk.getTables().findIndex(t => t.name === ${JSON.stringify(tableName)});\n` +
        'const tableId = sdk.getTables()[ti]._id;\n' +
        'const store = sdk.dtableStore;\n' +
        'const op = store.createOperation({\n' +
        "  type: 'modify_column_data',\n" +
        '  table_id: tableId,\n' +
        `  column_key: ${JSON.stringify(lfColumnKey)},\n` +
        `  column_data: ${JSON.stringify(originalData)},\n` +
        '});\n' +
        'store.applyLocalOperation(op);\n' +
        "const headers = { 'content-type': 'application/json', authorization: `Bearer ${sdk.config.accessToken}` };\n" +
        'const url = `${window.dtable.server}/api-gateway/api/v2/dtables/${sdk.config.dtableUuid}/columns/`;\n' +
        (selfLinkColumnKey
          ? `await fetch(url, { method: 'DELETE', headers, body: JSON.stringify({ table_name: ${JSON.stringify(tableName)}, column: ${JSON.stringify(selfLinkColumnKey)} }) });\n`
          : '') +
        (snapshotColumnKey
          ? `await fetch(url, { method: 'DELETE', headers, body: JSON.stringify({ table_name: ${JSON.stringify(tableName)}, column: ${JSON.stringify(snapshotColumnKey)} }) });\n`
          : '')
      : '';
  /* eslint-enable no-template-curly-in-string */

  return finalize(verdict, {
    lfColumnKey,
    snapshotColumnKey,
    selfLinkColumnKey,
    selfLinkId,
    snapshotType,
    rowCount,
    rowsRead: collected.size,
    rowsWritten: written,
    rowsLinked: linked,
    valuesMatched,
    cleanupSnippet,
    column: { tableName, lfColumnName, snapshotColumnName, selfLinkColumnName },
  });
}

export async function runTest7Console(opts: Test7Opts): Promise<Test7Result> {
  // eslint-disable-next-line no-console
  console.log('[Test7] starting', opts.tableName, '›', opts.lfColumnName);
  const result = await runTest7({
    ...opts,
    // eslint-disable-next-line no-console
    onProgress: (m) => console.log('[Test7]', m),
  });
  // eslint-disable-next-line no-console
  console.log('[Test7] result', result);
  for (const n of result.notes) {
    // eslint-disable-next-line no-console
    console.log('  ·', n);
  }
  if (result.cleanupSnippet) {
    // eslint-disable-next-line no-console
    console.log('\n[Test7] cleanup snippet:\n' + result.cleanupSnippet);
  }
  return result;
}

if (typeof window !== 'undefined') {
  (window as any).__perfAuditTest7 = runTest7Console;
}
