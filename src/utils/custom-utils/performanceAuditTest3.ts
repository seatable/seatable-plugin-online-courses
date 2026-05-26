/**
 * Test 3 — full apply pipeline for indirection-based replace-static.
 *
 * Builds on Test 2's verification that `setColumnData` can swap a formula
 * expression to a `{Donor}` reference cheaply and lazily. Test 3 exercises
 * the ENTIRE production-like flow on a real column:
 *
 *   1. Add a donor column (HTTP — independent of row count).
 *   2. Read the formula column's current values via SQL in 10k-row chunks.
 *   3. Populate the donor column via `batch_update_rows` in 1000-row chunks.
 *   4. Swap the formula column's expression to `{Donor}` via setColumnData.
 *   5. Verify a sample of rows now matches between formula column and donor.
 *   6. (Default) Restore: swap formula back, delete donor column.
 *
 * Every step uses an endpoint with no 60s wall (SQL with LIMIT, batch ops
 * sized at 1000, metadata-only setColumnData). Total wall time scales with
 * row count but every operation is bounded.
 *
 * Pass `autoRestore: false` if you want to inspect the post-swap state in
 * the SeaTable UI before reverting. In that mode the test leaves the
 * column pointing at the donor and the donor populated — you can manually
 * revert with the snippets logged in the result.
 *
 * MUTATES A REAL COLUMN AND ADDS A COLUMN. Caller must pass
 * `acknowledgeProduction: true`. Use a test base or a column you can
 * easily restore manually.
 */

interface TrialResult {
  ok: boolean;
  ms: number;
  error?: string;
  detail?: string;
}

export interface Test3Opts {
  dtableSDK: any;
  tableName: string;
  /** Formula column to "freeze". Will be swapped to point at the new donor. */
  formulaColumnName: string;
  /**
   * Optional donor column name. Defaults to `_snapshot_<formulaColumnName>`.
   * Must NOT already exist on the table — Test 3 creates it.
   */
  donorColumnName?: string;
  /**
   * When true (default), restores the original formula and deletes the donor
   * at the end. Set to false to leave the column frozen for UI inspection.
   */
  autoRestore?: boolean;
  acknowledgeProduction?: boolean;
  accessToken?: string;
  dtableUuid?: string;
  onProgress?: (msg: string) => void;
  /** Per-batch upper bound for SQL pagination + batch_update_rows. */
  sqlChunkSize?: number; // default 10_000 (SeaTable SQL cap)
  batchUpdateChunkSize?: number; // default 1_000 (batch_update_rows API limit)
  /** Per-request HTTP timeout. Default 90s (server-side ops capped at 60s by nginx). */
  httpTimeoutMs?: number;
}

export interface Test3Result {
  column: { tableName: string; formulaColumnName: string; donorColumnName: string };
  formulaColumnKey: string;
  donorColumnKey: string; // empty if creation failed
  donorColumnType: string;
  rowCount: number;
  rowsRead: number;
  rowsWritten: number;
  phases: {
    addDonor: TrialResult;
    sqlRead: TrialResult;
    batchPopulate: TrialResult;
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
    | 'aborted';
  cleanupSnippet: string; // shown if autoRestore was false
  notes: string[];
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ resp?: Response; aborted: boolean; error?: string }> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    return { resp, aborted: false };
  } catch (e: any) {
    return { aborted: ctrl.signal.aborted, error: e?.message || String(e) };
  } finally {
    clearTimeout(id);
  }
}

/** Map a formula column's `result_type` to a sensible donor column type. */
function donorTypeForResultType(resultType: string | undefined): string {
  switch (resultType) {
    case 'number':
      return 'number';
    case 'bool':
      return 'checkbox';
    case 'date':
      return 'date';
    case 'string':
      return 'text';
    case 'array':
      return 'long-text'; // arrays render as comma-separated strings in cells
    default:
      return 'text';
  }
}

async function httpAddColumn(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  tableName: string,
  columnName: string,
  columnType: string,
  timeoutMs: number
): Promise<{ ok: boolean; ms: number; key?: string; body?: string; status: number }> {
  const t0 = Date.now();
  const { resp, error } = await fetchWithTimeout(
    `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/columns/`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        table_name: tableName,
        column_name: columnName,
        column_type: columnType,
      }),
    },
    timeoutMs
  );
  const ms = Date.now() - t0;
  if (error) return { ok: false, ms, status: 0, body: error };
  if (!resp || !resp.ok) {
    const body = resp ? await resp.text().catch(() => '') : '';
    return { ok: false, ms, status: resp?.status ?? 0, body };
  }
  const data = await resp.json().catch(() => ({}));
  return { ok: true, ms, status: resp.status, key: data?.key };
}

async function httpDeleteColumn(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  tableName: string,
  columnKey: string,
  timeoutMs: number
): Promise<{ ok: boolean; ms: number; body?: string; status: number }> {
  const t0 = Date.now();
  const { resp, error } = await fetchWithTimeout(
    `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/columns/`,
    {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ table_name: tableName, column: columnKey }),
    },
    timeoutMs
  );
  const ms = Date.now() - t0;
  if (error) return { ok: false, ms, status: 0, body: error };
  if (!resp || !resp.ok) {
    const body = resp ? await resp.text().catch(() => '') : '';
    return { ok: false, ms, status: resp?.status ?? 0, body };
  }
  return { ok: true, ms, status: resp.status };
}

async function httpSqlChunk(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  sql: string,
  timeoutMs: number
): Promise<{
  ok: boolean;
  ms: number;
  rows: any[];
  metadata: any[];
  body?: string;
  status: number;
}> {
  const t0 = Date.now();
  const { resp, error } = await fetchWithTimeout(
    `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/sql/`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ sql }),
    },
    timeoutMs
  );
  const ms = Date.now() - t0;
  if (error) return { ok: false, ms, status: 0, rows: [], metadata: [], body: error };
  if (!resp || !resp.ok) {
    const body = resp ? await resp.text().catch(() => '') : '';
    return { ok: false, ms, status: resp?.status ?? 0, rows: [], metadata: [], body };
  }
  const data = await resp.json().catch(() => ({}));
  const rows: any[] = data?.results || data?.rows || [];
  const metadata: any[] = data?.metadata || data?.columns || [];
  return { ok: true, ms, status: resp.status, rows, metadata };
}

async function httpBatchUpdate(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  tableName: string,
  updates: { row_id: string; row: Record<string, any> }[],
  timeoutMs: number
): Promise<{ ok: boolean; ms: number; body?: string; status: number }> {
  // Batch update goes through the rows endpoint, not a dedicated batch URL.
  // Confirmed against seatable-api-python's `batch_update_rows` which PUTs
  // `{table_name, updates}` to `/api/v2/dtables/<uuid>/rows/`.
  const t0 = Date.now();
  const { resp, error } = await fetchWithTimeout(
    `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/rows/`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ table_name: tableName, updates }),
    },
    timeoutMs
  );
  const ms = Date.now() - t0;
  if (error) return { ok: false, ms, status: 0, body: error };
  if (!resp || !resp.ok) {
    const body = resp ? await resp.text().catch(() => '') : '';
    return { ok: false, ms, status: resp?.status ?? 0, body };
  }
  return { ok: true, ms, status: resp.status };
}

export async function runTest3(opts: Test3Opts): Promise<Test3Result> {
  const {
    dtableSDK,
    tableName,
    formulaColumnName,
    autoRestore = true,
    acknowledgeProduction = false,
    onProgress,
    sqlChunkSize = 10_000,
    batchUpdateChunkSize = 1_000,
    httpTimeoutMs = 90 * 1000,
  } = opts;
  const accessToken: string = opts.accessToken || dtableSDK?.config?.accessToken || '';
  const dtableUuid: string = opts.dtableUuid || dtableSDK?.config?.dtableUuid || '';
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';

  const notes: string[] = [];
  const phases: Test3Result['phases'] = {
    addDonor: { ok: false, ms: 0, error: 'not attempted' },
    sqlRead: { ok: false, ms: 0, error: 'not attempted' },
    batchPopulate: { ok: false, ms: 0, error: 'not attempted' },
    swap: { ok: false, ms: 0, error: 'not attempted' },
    verify: { ok: false, ms: 0, error: 'not attempted' },
    restore: { ok: false, ms: 0, error: 'not attempted' },
  };

  const finalize = (
    verdict: Test3Result['verdict'],
    extra?: Partial<Test3Result>
  ): Test3Result => ({
    column: {
      tableName,
      formulaColumnName,
      donorColumnName: extra?.column?.donorColumnName || opts.donorColumnName || '',
    },
    formulaColumnKey: extra?.formulaColumnKey || '',
    donorColumnKey: extra?.donorColumnKey || '',
    donorColumnType: extra?.donorColumnType || '',
    rowCount: extra?.rowCount || 0,
    rowsRead: extra?.rowsRead || 0,
    rowsWritten: extra?.rowsWritten || 0,
    phases,
    valuesMatched: extra?.valuesMatched ?? null,
    verdict,
    cleanupSnippet: extra?.cleanupSnippet || '',
    notes,
    ...extra,
  });

  if (!acknowledgeProduction) {
    notes.push(`aborted: pass acknowledgeProduction: true to mutate the base`);
    return finalize('aborted');
  }
  if (!accessToken || !dtableUuid) {
    notes.push(
      `aborted: missing auth — accessToken ${accessToken ? 'ok' : 'EMPTY'}, dtableUuid ${dtableUuid ? 'ok' : 'EMPTY'}`
    );
    return finalize('aborted');
  }

  // ---- Pre-flight: locate formula column, capture original
  const tables: any[] = dtableSDK.getTables();
  const tableIndex = tables.findIndex((t: any) => t.name === tableName);
  if (tableIndex < 0) {
    notes.push(`aborted: table "${tableName}" not found`);
    return finalize('aborted');
  }
  const tbl = tables[tableIndex];
  const formulaCol = (tbl.columns || []).find((c: any) => c.name === formulaColumnName);
  if (!formulaCol) {
    notes.push(`aborted: column "${formulaColumnName}" not found in "${tableName}"`);
    return finalize('aborted');
  }
  if (formulaCol.type !== 'formula') {
    notes.push(`aborted: "${formulaColumnName}" is type "${formulaCol.type}", expected "formula"`);
    return finalize('aborted');
  }

  const formulaColumnKey: string = formulaCol.key;
  const originalData = JSON.parse(JSON.stringify(formulaCol.data || {}));
  const resultType: string | undefined = originalData.result_type;
  const donorColumnName = opts.donorColumnName || `_snapshot_${formulaColumnName}`;
  const donorColumnType = donorTypeForResultType(resultType);
  const rowCount = (tbl.rows || []).length;

  // Reject if donor name collides with an existing column.
  if ((tbl.columns || []).find((c: any) => c.name === donorColumnName)) {
    notes.push(
      `aborted: donor column "${donorColumnName}" already exists. Pass a different donorColumnName or remove the existing column first.`
    );
    return finalize('aborted');
  }

  notes.push(
    `formula column: ${tableName} › ${formulaColumnName} (key=${formulaColumnKey}, rows=${rowCount}, result_type=${resultType})`
  );
  notes.push(`donor (to create): "${donorColumnName}" type=${donorColumnType}`);
  notes.push(
    `autoRestore=${autoRestore}, sqlChunk=${sqlChunkSize}, batchChunk=${batchUpdateChunkSize}`
  );

  // ---- Phase 1: Add donor column
  if (onProgress)
    onProgress(`Phase 1/6: Adding donor column "${donorColumnName}" (${donorColumnType})...`);
  const addRes = await httpAddColumn(
    serverUrl,
    dtableUuid,
    accessToken,
    tableName,
    donorColumnName,
    donorColumnType,
    httpTimeoutMs
  );
  phases.addDonor = {
    ok: addRes.ok,
    ms: addRes.ms,
    error: addRes.ok ? undefined : `HTTP ${addRes.status}: ${(addRes.body || '').slice(0, 200)}`,
  };
  notes.push(
    `P1 addDonor: ${phases.addDonor.ok ? 'ok' : 'FAIL'} in ${fmt(phases.addDonor.ms)}${!phases.addDonor.ok && phases.addDonor.error ? ` — ${phases.addDonor.error}` : ''}`
  );
  if (!phases.addDonor.ok) {
    return finalize('aborted', { formulaColumnKey, donorColumnType, rowCount });
  }
  // The add-column response may or may not return the new column's key. Re-read
  // metadata to get it reliably.
  const donorColumnKey: string =
    addRes.key ||
    (await (async () => {
      const meta = await httpSqlChunk(
        serverUrl,
        dtableUuid,
        accessToken,
        `SELECT _id FROM \`${tableName}\` LIMIT 0`,
        httpTimeoutMs
      );
      const col = meta.metadata?.find((m: any) => (m.name || m.column_name) === donorColumnName);
      return col?.key || col?.column_key || '';
    })());
  if (!donorColumnKey) {
    notes.push(`WARNING: couldn't resolve donor column key — operations using key may fail`);
  } else {
    notes.push(`donor column_key: ${donorColumnKey}`);
  }

  // Single rollback path used on every failure after donor creation.
  const rollback = async (reason: string): Promise<void> => {
    notes.push(`rollback initiated: ${reason}`);
    // Restore the formula (if we swapped it).
    if (phases.swap.ok) {
      try {
        dtableSDK.dtableStore.setColumnData(tableIndex, formulaColumnKey, originalData);
        notes.push(`rollback: restored original formula via setColumnData`);
      } catch (e: any) {
        notes.push(`rollback: formula restore FAILED — ${e?.message || e}`);
      }
    }
    // Delete the donor column.
    if (donorColumnKey) {
      const del = await httpDeleteColumn(
        serverUrl,
        dtableUuid,
        accessToken,
        tableName,
        donorColumnKey,
        httpTimeoutMs
      );
      notes.push(
        `rollback: delete donor — ${del.ok ? 'ok' : 'FAILED'} in ${fmt(del.ms)}${del.body ? ` (${(del.body || '').slice(0, 100)})` : ''}`
      );
    }
  };

  // ---- Phase 2: SQL read in chunks
  if (onProgress)
    onProgress(`Phase 2/6: Reading ${rowCount} values via SQL in chunks of ${sqlChunkSize}...`);
  const t2 = Date.now();
  const collected: Map<string, any> = new Map();
  let sqlErr: string | undefined;
  for (let offset = 0; offset < rowCount; offset += sqlChunkSize) {
    if (onProgress) {
      onProgress(
        `P2 SQL read: rows ${offset}–${Math.min(offset + sqlChunkSize, rowCount)} of ${rowCount}...`
      );
    }
    const chunk = await httpSqlChunk(
      serverUrl,
      dtableUuid,
      accessToken,
      `SELECT _id, \`${formulaColumnName}\` FROM \`${tableName}\` LIMIT ${sqlChunkSize} OFFSET ${offset}`,
      httpTimeoutMs
    );
    if (!chunk.ok) {
      sqlErr = `HTTP ${chunk.status}: ${(chunk.body || '').slice(0, 200)}`;
      break;
    }
    // Resolve the value key for the formula column (rows are keyed by key, not name).
    const valKey =
      chunk.metadata.find((m: any) => (m.name || m.column_name) === formulaColumnName)?.key ||
      chunk.metadata.find((m: any) => (m.name || m.column_name) === formulaColumnName)
        ?.column_key ||
      formulaColumnKey;
    for (const r of chunk.rows) {
      const id = r._id || r._rowid || r['_id'];
      if (id) collected.set(id, r[valKey]);
    }
    if (chunk.rows.length < sqlChunkSize) break; // last page
  }
  phases.sqlRead.ms = Date.now() - t2;
  phases.sqlRead.ok = !sqlErr;
  if (sqlErr) phases.sqlRead.error = sqlErr;
  phases.sqlRead.detail = `read ${collected.size} row values`;
  notes.push(
    `P2 sqlRead: ${phases.sqlRead.ok ? 'ok' : 'FAIL'} in ${fmt(phases.sqlRead.ms)} — ${collected.size} rows${sqlErr ? ` (${sqlErr})` : ''}`
  );
  if (!phases.sqlRead.ok) {
    await rollback('SQL read failed');
    return finalize('restored-after-failure', {
      formulaColumnKey,
      donorColumnKey,
      donorColumnType,
      rowCount,
      rowsRead: collected.size,
    });
  }

  // ---- Phase 3: batch_update_rows to populate donor
  if (onProgress)
    onProgress(`Phase 3/6: Populating donor column in chunks of ${batchUpdateChunkSize}...`);
  const t3 = Date.now();
  const allUpdates = Array.from(collected.entries()).map(([row_id, value]) => ({
    row_id,
    row: { [donorColumnName]: value },
  }));
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
      formulaColumnKey,
      donorColumnKey,
      donorColumnType,
      rowCount,
      rowsRead: collected.size,
      rowsWritten: written,
    });
  }

  // ---- Phase 4: setColumnData swap (the part we already validated via Test 2)
  if (onProgress)
    onProgress(`Phase 4/6: Swapping formula to {${donorColumnName}} via setColumnData...`);
  const t4 = Date.now();
  const donorRefData = {
    ...originalData,
    formula: `{${donorColumnName}}`,
    operated_columns: donorColumnKey ? [donorColumnKey] : originalData.operated_columns || [],
  };
  try {
    dtableSDK.dtableStore.setColumnData(tableIndex, formulaColumnKey, donorRefData);
    // Quick local-state sanity check.
    const after = (dtableSDK.getTables()?.[tableIndex]?.columns || []).find(
      (c: any) => c.key === formulaColumnKey
    );
    if (after?.data?.formula !== donorRefData.formula) {
      throw new Error(
        `SDK local state didn't accept the swap (got formula=${JSON.stringify(after?.data?.formula)})`
      );
    }
    phases.swap.ok = true;
  } catch (e: any) {
    phases.swap.error = e?.message || String(e);
  }
  phases.swap.ms = Date.now() - t4;
  notes.push(
    `P4 swap: ${phases.swap.ok ? 'ok' : 'FAIL'} in ${fmt(phases.swap.ms)}${!phases.swap.ok && phases.swap.error ? ` — ${phases.swap.error}` : ''}`
  );
  if (!phases.swap.ok) {
    await rollback('setColumnData swap failed');
    return finalize('restored-after-failure', {
      formulaColumnKey,
      donorColumnKey,
      donorColumnType,
      rowCount,
      rowsRead: collected.size,
      rowsWritten: written,
    });
  }

  // ---- Phase 5: Verify a sample matches between formula column and donor
  if (onProgress) onProgress(`Phase 5/6: Verifying via SQL sample (10 rows)...`);
  const t5 = Date.now();
  const verify = await httpSqlChunk(
    serverUrl,
    dtableUuid,
    accessToken,
    `SELECT \`${formulaColumnName}\`, \`${donorColumnName}\` FROM \`${tableName}\` LIMIT 10`,
    httpTimeoutMs
  );
  phases.verify.ms = Date.now() - t5;
  let valuesMatched: number | null = null;
  if (!verify.ok) {
    phases.verify.error = `HTTP ${verify.status}: ${(verify.body || '').slice(0, 200)}`;
  } else {
    const fKey =
      verify.metadata.find((m: any) => (m.name || m.column_name) === formulaColumnName)?.key ||
      verify.metadata.find((m: any) => (m.name || m.column_name) === formulaColumnName)
        ?.column_key ||
      formulaColumnKey;
    const dKey =
      verify.metadata.find((m: any) => (m.name || m.column_name) === donorColumnName)?.key ||
      verify.metadata.find((m: any) => (m.name || m.column_name) === donorColumnName)?.column_key ||
      donorColumnKey;
    let matched = 0;
    for (const r of verify.rows) {
      const f = r[fKey];
      const d = r[dKey];
      if (f === undefined && d === undefined) continue;
      if (f === d || String(f ?? '') === String(d ?? '')) matched++;
    }
    valuesMatched = matched;
    phases.verify.ok = matched === verify.rows.length;
    phases.verify.detail = `${matched}/${verify.rows.length} sampled rows match`;
    notes.push(
      `P5 verify sample (first 3): ${JSON.stringify(verify.rows.slice(0, 3))}`.slice(0, 400)
    );
  }
  notes.push(
    `P5 verify: ${phases.verify.ok ? 'ok' : 'FAIL'} in ${fmt(phases.verify.ms)} — ${phases.verify.detail || phases.verify.error}`
  );

  // ---- Phase 6: Restore (or leave frozen)
  if (autoRestore) {
    if (onProgress) onProgress(`Phase 6/6: Restoring original formula + deleting donor column...`);
    const t6 = Date.now();
    let restoreErr: string | undefined;
    try {
      dtableSDK.dtableStore.setColumnData(tableIndex, formulaColumnKey, originalData);
    } catch (e: any) {
      restoreErr = `setColumnData restore: ${e?.message || e}`;
    }
    if (!restoreErr && donorColumnKey) {
      const del = await httpDeleteColumn(
        serverUrl,
        dtableUuid,
        accessToken,
        tableName,
        donorColumnKey,
        httpTimeoutMs
      );
      if (!del.ok)
        restoreErr = `delete donor: HTTP ${del.status}: ${(del.body || '').slice(0, 200)}`;
    }
    phases.restore.ms = Date.now() - t6;
    phases.restore.ok = !restoreErr;
    if (restoreErr) phases.restore.error = restoreErr;
    notes.push(
      `P6 restore: ${phases.restore.ok ? 'ok' : 'FAIL'} in ${fmt(phases.restore.ms)}${restoreErr ? ` — ${restoreErr}` : ''}`
    );
  } else {
    phases.restore = {
      ok: true,
      ms: 0,
      detail: 'skipped (autoRestore=false) — left frozen for UI inspection',
    };
    notes.push(
      `P6 restore SKIPPED — column is currently frozen. Run cleanup snippet (see result.cleanupSnippet) to revert.`
    );
  }

  // Verdict
  let verdict: Test3Result['verdict'];
  if (!phases.swap.ok || !phases.verify.ok) {
    verdict = 'restored-after-failure';
  } else if (valuesMatched !== null && valuesMatched === 0) {
    verdict = 'mismatch';
  } else if (!autoRestore) {
    verdict = 'left-frozen';
  } else {
    // Heuristic: total wall time over 5min × (rows/10000) is "slow"; otherwise works.
    const total =
      phases.addDonor.ms +
      phases.sqlRead.ms +
      phases.batchPopulate.ms +
      phases.swap.ms +
      phases.verify.ms +
      phases.restore.ms;
    const slowThreshold = 5 * 60 * 1000 * Math.max(1, rowCount / 10_000);
    verdict = total > slowThreshold ? 'works-but-slow' : 'works';
    notes.push(`total wall time: ${fmt(total)}`);
  }
  notes.push(`verdict: ${verdict}`);

  const cleanupSnippet =
    !autoRestore && donorColumnKey
      ? `// Run this to restore:\n` +
        `const sdk = window.dtableSDK;\n` +
        `const ti = sdk.getTables().findIndex(t => t.name === ${JSON.stringify(tableName)});\n` +
        `sdk.dtableStore.setColumnData(ti, ${JSON.stringify(formulaColumnKey)}, ${JSON.stringify(originalData)});\n` +
        `await fetch(\`\${window.dtable.server}/api-gateway/api/v2/dtables/\${sdk.config.dtableUuid}/columns/\`, {\n` +
        `  method: 'DELETE',\n` +
        `  headers: { 'content-type': 'application/json', authorization: \`Bearer \${sdk.config.accessToken}\` },\n` +
        `  body: JSON.stringify({ table_name: ${JSON.stringify(tableName)}, column: ${JSON.stringify(donorColumnKey)} }),\n` +
        `});`
      : '';

  return finalize(verdict, {
    formulaColumnKey,
    donorColumnKey,
    donorColumnType,
    rowCount,
    rowsRead: collected.size,
    rowsWritten: written,
    valuesMatched,
    cleanupSnippet,
    column: { tableName, formulaColumnName, donorColumnName },
  });
}

export async function runTest3Console(opts: Test3Opts): Promise<Test3Result> {
  // eslint-disable-next-line no-console
  console.log('[Test3] starting', opts.tableName, '›', opts.formulaColumnName);
  const result = await runTest3({
    ...opts,
    // eslint-disable-next-line no-console
    onProgress: (m) => console.log('[Test3]', m),
  });
  // eslint-disable-next-line no-console
  console.log('[Test3] result', result);
  for (const n of result.notes) {
    // eslint-disable-next-line no-console
    console.log('  ·', n);
  }
  if (result.cleanupSnippet) {
    // eslint-disable-next-line no-console
    console.log('\n[Test3] cleanup snippet:\n' + result.cleanupSnippet);
  }
  return result;
}

if (typeof window !== 'undefined') {
  (window as any).__perfAuditTest3 = runTest3Console;
}
