/**
 * Test 4 — indirection-via-donor-column for LINK-FORMULA columns.
 *
 * Same skeleton as Test 3, but the formula column starts as `link-formula`
 * and the step-4 swap uses HTTP `modify_column_type` to change the type to
 * plain `formula` with `formula: '{Donor}'`. We can't just rewrite the
 * `data.formula` in place like Test 3 does, because link-formula's `formula`
 * field is an operation name (`lookup`, `findmax`, etc.), not an expression
 * that accepts a `{column}` reference.
 *
 * The hypothesis: link-formula → formula type change *may* stay metadata-only
 * server-side, because both source and target are computed-on-read column
 * types. Unlike Test 1b's `formula → text` (which 504'd because text is
 * per-row stored data), there's no per-row write target here. If true, this
 * gives us a "freeze" path for link-formulas with the same properties as
 * Test 3 (column_key preserved, downstream references untouched, no rewiring).
 *
 * Restore caveat: rolling back from plain formula to link-formula requires
 * another `modify_column_type`. On a big table, this could also 504 — we
 * don't know yet. The harness reports both directions' timings; if restore
 * fails, the donor stays populated and the column stays as a plain formula
 * pointing at the donor (no data lost, just not the original schema). A
 * cleanup snippet is logged in that case.
 *
 * Order recommendation: run on a SMALL link-formula column first to verify
 * the mechanism works at all. Only scale to a big column once that confirms.
 *
 * MUTATES A REAL COLUMN AND ADDS A COLUMN. Pass acknowledgeProduction: true.
 */

interface TrialResult {
  ok: boolean;
  ms: number;
  error?: string;
  detail?: string;
}

export interface Test4Opts {
  dtableSDK: any;
  tableName: string;
  /** Link-formula column to "freeze". Will become plain formula → {Donor}. */
  linkFormulaColumnName: string;
  /** Optional donor column name. Defaults to `_snapshot_<linkFormulaColumnName>`. */
  donorColumnName?: string;
  /** When true (default), restores the original link-formula and deletes the donor at the end. */
  autoRestore?: boolean;
  acknowledgeProduction?: boolean;
  accessToken?: string;
  dtableUuid?: string;
  onProgress?: (msg: string) => void;
  sqlChunkSize?: number; // default 10_000
  batchUpdateChunkSize?: number; // default 1_000
  httpTimeoutMs?: number; // default 90s — server-side is capped at 60s by nginx
}

export interface Test4Result {
  column: { tableName: string; linkFormulaColumnName: string; donorColumnName: string };
  linkFormulaColumnKey: string;
  donorColumnKey: string;
  donorColumnType: string;
  originalLinkFormula: string;
  rowCount: number;
  rowsRead: number;
  rowsWritten: number;
  phases: {
    addDonor: TrialResult;
    sqlRead: TrialResult;
    batchPopulate: TrialResult;
    swapToFormula: TrialResult; // HTTP modify_column_type — the load-bearing test
    verify: TrialResult;
    restoreToLinkFormula: TrialResult; // HTTP modify_column_type back — may 504 on big tables
    deleteDonor: TrialResult;
  };
  valuesMatched: number | null;
  verdict:
    | 'works'
    | 'works-but-restore-failed' // forward path worked, rollback hit the wall
    | 'forward-too-slow'
    | 'forward-failed' // modify_column_type failed; column is intact
    | 'mismatch'
    | 'restored-after-failure'
    | 'left-frozen'
    | 'aborted';
  cleanupSnippet: string;
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

/**
 * Pick a donor column type from the link-formula's effective output.
 *   - result_type='array' → 'long-text' (stores JSON-stringified arrays / comma-separated values)
 *   - result_type='string'/'number'/'bool'/'date' → matching plain types
 */
function donorTypeForLinkFormula(originalData: any): { type: string; newResultType: string } {
  const rt: string | undefined = originalData?.result_type;
  if (rt === 'array') return { type: 'long-text', newResultType: 'string' };
  if (rt === 'number') return { type: 'number', newResultType: 'number' };
  if (rt === 'bool') return { type: 'checkbox', newResultType: 'bool' };
  if (rt === 'date') return { type: 'date', newResultType: 'date' };
  return { type: 'text', newResultType: 'string' };
}

/** Serialize an SQL-returned link-formula value into a donor-storable scalar. */
function serializeForDonor(value: any, donorType: string): any {
  if (value === null || value === undefined) return null;
  if (donorType === 'long-text') {
    // Arrays come back as JS arrays from SQL. Store as JSON for round-trip clarity.
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
  return value;
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

/**
 * HTTP modify_column_type — server-side type change. The load-bearing call.
 * Returns timing + status; caller decides verdict. Per-call timeout is the
 * HTTP envelope; the server-side nginx wall is 60s independently.
 */
async function httpModifyColumnType(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  tableName: string,
  columnKey: string,
  newColumnType: string,
  columnData: any,
  timeoutMs: number
): Promise<{ ok: boolean; ms: number; status: number; body?: string }> {
  const t0 = Date.now();
  const { resp, aborted, error } = await fetchWithTimeout(
    `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/columns/`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        op_type: 'modify_column_type',
        table_name: tableName,
        column: columnKey,
        new_column_type: newColumnType,
        column_data: columnData,
      }),
    },
    timeoutMs
  );
  const ms = Date.now() - t0;
  if (aborted) return { ok: false, ms, status: 0, body: `client abort after ${fmt(timeoutMs)}` };
  if (error) return { ok: false, ms, status: 0, body: error };
  if (!resp || !resp.ok) {
    const body = resp ? await resp.text().catch(() => '') : '';
    return { ok: false, ms, status: resp?.status ?? 0, body };
  }
  return { ok: true, ms, status: resp.status };
}

export async function runTest4(opts: Test4Opts): Promise<Test4Result> {
  const {
    dtableSDK,
    tableName,
    linkFormulaColumnName,
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
  const phases: Test4Result['phases'] = {
    addDonor: { ok: false, ms: 0 },
    sqlRead: { ok: false, ms: 0 },
    batchPopulate: { ok: false, ms: 0 },
    swapToFormula: { ok: false, ms: 0 },
    verify: { ok: false, ms: 0 },
    restoreToLinkFormula: { ok: false, ms: 0 },
    deleteDonor: { ok: false, ms: 0 },
  };

  const finalize = (
    verdict: Test4Result['verdict'],
    extra?: Partial<Test4Result>
  ): Test4Result => ({
    column: {
      tableName,
      linkFormulaColumnName,
      donorColumnName: extra?.column?.donorColumnName || opts.donorColumnName || '',
    },
    linkFormulaColumnKey: extra?.linkFormulaColumnKey || '',
    donorColumnKey: extra?.donorColumnKey || '',
    donorColumnType: extra?.donorColumnType || '',
    originalLinkFormula: extra?.originalLinkFormula || '',
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

  // ---- Pre-flight: locate link-formula column
  const tables: any[] = dtableSDK.getTables();
  const tableIndex = tables.findIndex((t: any) => t.name === tableName);
  if (tableIndex < 0) {
    notes.push(`aborted: table "${tableName}" not found`);
    return finalize('aborted');
  }
  const tbl = tables[tableIndex];
  const lfCol = (tbl.columns || []).find((c: any) => c.name === linkFormulaColumnName);
  if (!lfCol) {
    notes.push(`aborted: column "${linkFormulaColumnName}" not found in "${tableName}"`);
    return finalize('aborted');
  }
  if (lfCol.type !== 'link-formula') {
    notes.push(
      `aborted: "${linkFormulaColumnName}" is type "${lfCol.type}", expected "link-formula"`
    );
    return finalize('aborted');
  }

  const linkFormulaColumnKey: string = lfCol.key;
  const originalData = JSON.parse(JSON.stringify(lfCol.data || {}));
  const originalLinkFormula: string = originalData.formula || '';
  const donorColumnName = opts.donorColumnName || `_snapshot_${linkFormulaColumnName}`;
  const { type: donorColumnType, newResultType } = donorTypeForLinkFormula(originalData);
  const rowCount = (tbl.rows || []).length;

  if ((tbl.columns || []).find((c: any) => c.name === donorColumnName)) {
    notes.push(
      `aborted: donor "${donorColumnName}" already exists. Pass a different donorColumnName or remove the existing column first.`
    );
    return finalize('aborted');
  }

  notes.push(
    `link-formula: ${tableName} › ${linkFormulaColumnName} (key=${linkFormulaColumnKey}, rows=${rowCount}, formula=${originalLinkFormula}, result_type=${originalData.result_type}${originalData.array_type ? `, array_type=${originalData.array_type}` : ''})`
  );
  notes.push(
    `donor (to create): "${donorColumnName}" type=${donorColumnType}, new result_type=${newResultType}`
  );
  notes.push(
    `autoRestore=${autoRestore}, sqlChunk=${sqlChunkSize}, batchChunk=${batchUpdateChunkSize}`
  );

  // ---- Phase 1: Add donor
  if (onProgress)
    onProgress(`Phase 1/7: Adding donor column "${donorColumnName}" (${donorColumnType})...`);
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
    return finalize('aborted', {
      linkFormulaColumnKey,
      donorColumnType,
      rowCount,
      originalLinkFormula,
    });
  }
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

  // Centralized rollback for any failure between Phase 1 and the autoRestore step.
  const rollback = async (reason: string): Promise<void> => {
    notes.push(`rollback initiated: ${reason}`);
    if (phases.swapToFormula.ok) {
      // The column is currently plain formula → {donor}. Restore link-formula.
      const r = await httpModifyColumnType(
        serverUrl,
        dtableUuid,
        accessToken,
        tableName,
        linkFormulaColumnKey,
        'link-formula',
        originalData,
        httpTimeoutMs
      );
      notes.push(
        `rollback: restore link-formula — ${r.ok ? 'ok' : `FAILED (HTTP ${r.status}: ${(r.body || '').slice(0, 100)})`} in ${fmt(r.ms)}`
      );
    }
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

  // ---- Phase 2: SQL read (chunked)
  if (onProgress)
    onProgress(`Phase 2/7: Reading ${rowCount} values via SQL in chunks of ${sqlChunkSize}...`);
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
      `SELECT _id, \`${linkFormulaColumnName}\` FROM \`${tableName}\` LIMIT ${sqlChunkSize} OFFSET ${offset}`,
      httpTimeoutMs
    );
    if (!chunk.ok) {
      sqlErr = `HTTP ${chunk.status}: ${(chunk.body || '').slice(0, 200)}`;
      break;
    }
    const valKey =
      chunk.metadata.find((m: any) => (m.name || m.column_name) === linkFormulaColumnName)?.key ||
      chunk.metadata.find((m: any) => (m.name || m.column_name) === linkFormulaColumnName)
        ?.column_key ||
      linkFormulaColumnKey;
    for (const r of chunk.rows) {
      const id = r._id;
      if (id) collected.set(id, serializeForDonor(r[valKey], donorColumnType));
    }
    if (chunk.rows.length < sqlChunkSize) break;
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
      linkFormulaColumnKey,
      donorColumnKey,
      donorColumnType,
      rowCount,
      originalLinkFormula,
      rowsRead: collected.size,
    });
  }

  // ---- Phase 3: Populate donor
  if (onProgress)
    onProgress(`Phase 3/7: Populating donor column in chunks of ${batchUpdateChunkSize}...`);
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
      linkFormulaColumnKey,
      donorColumnKey,
      donorColumnType,
      rowCount,
      originalLinkFormula,
      rowsRead: collected.size,
      rowsWritten: written,
    });
  }

  // ---- Phase 4: THE LOAD-BEARING TEST — HTTP modify_column_type from link-formula to formula
  if (onProgress)
    onProgress(
      `Phase 4/7: HTTP modify_column_type(link-formula → formula with {${donorColumnName}})...`
    );
  const newFormulaData = {
    formula: `{${donorColumnName}}`,
    operated_columns: donorColumnKey ? [donorColumnKey] : [],
    result_type: newResultType,
  };
  const p4 = await httpModifyColumnType(
    serverUrl,
    dtableUuid,
    accessToken,
    tableName,
    linkFormulaColumnKey,
    'formula',
    newFormulaData,
    httpTimeoutMs
  );
  phases.swapToFormula.ok = p4.ok;
  phases.swapToFormula.ms = p4.ms;
  if (!p4.ok) phases.swapToFormula.error = `HTTP ${p4.status}: ${(p4.body || '').slice(0, 200)}`;
  notes.push(
    `P4 swapToFormula: ${phases.swapToFormula.ok ? 'ok' : 'FAIL'} in ${fmt(phases.swapToFormula.ms)} (status ${p4.status})${phases.swapToFormula.error ? ` — ${phases.swapToFormula.error}` : ''}`
  );
  if (!phases.swapToFormula.ok) {
    // The column wasn't actually swapped server-side; just delete the donor.
    const del = await httpDeleteColumn(
      serverUrl,
      dtableUuid,
      accessToken,
      tableName,
      donorColumnKey,
      httpTimeoutMs
    );
    notes.push(`P4 cleanup: delete donor — ${del.ok ? 'ok' : 'FAILED'} in ${fmt(del.ms)}`);
    return finalize(p4.status === 504 ? 'forward-too-slow' : 'forward-failed', {
      linkFormulaColumnKey,
      donorColumnKey,
      donorColumnType,
      rowCount,
      originalLinkFormula,
      rowsRead: collected.size,
      rowsWritten: written,
    });
  }

  // ---- Phase 5: Verify a sample
  if (onProgress) onProgress(`Phase 5/7: Verifying via SQL sample (10 rows)...`);
  const t5 = Date.now();
  const verify = await httpSqlChunk(
    serverUrl,
    dtableUuid,
    accessToken,
    `SELECT \`${linkFormulaColumnName}\`, \`${donorColumnName}\` FROM \`${tableName}\` LIMIT 10`,
    httpTimeoutMs
  );
  phases.verify.ms = Date.now() - t5;
  let valuesMatched: number | null = null;
  if (!verify.ok) {
    phases.verify.error = `HTTP ${verify.status}: ${(verify.body || '').slice(0, 200)}`;
  } else {
    const fKey =
      verify.metadata.find((m: any) => (m.name || m.column_name) === linkFormulaColumnName)?.key ||
      verify.metadata.find((m: any) => (m.name || m.column_name) === linkFormulaColumnName)
        ?.column_key ||
      linkFormulaColumnKey;
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
    if (onProgress)
      onProgress(
        `Phase 6/7: HTTP modify_column_type(formula → link-formula) — may 504 on big tables...`
      );
    const p6 = await httpModifyColumnType(
      serverUrl,
      dtableUuid,
      accessToken,
      tableName,
      linkFormulaColumnKey,
      'link-formula',
      originalData,
      httpTimeoutMs
    );
    phases.restoreToLinkFormula.ok = p6.ok;
    phases.restoreToLinkFormula.ms = p6.ms;
    if (!p6.ok)
      phases.restoreToLinkFormula.error = `HTTP ${p6.status}: ${(p6.body || '').slice(0, 200)}`;
    notes.push(
      `P6 restoreToLinkFormula: ${phases.restoreToLinkFormula.ok ? 'ok' : 'FAIL'} in ${fmt(phases.restoreToLinkFormula.ms)} (status ${p6.status})${phases.restoreToLinkFormula.error ? ` — ${phases.restoreToLinkFormula.error}` : ''}`
    );

    // ---- Phase 7: Delete donor (only if restore succeeded — if it didn't, donor is still load-bearing)
    if (phases.restoreToLinkFormula.ok) {
      if (onProgress) onProgress(`Phase 7/7: Deleting donor column...`);
      const del = await httpDeleteColumn(
        serverUrl,
        dtableUuid,
        accessToken,
        tableName,
        donorColumnKey,
        httpTimeoutMs
      );
      phases.deleteDonor.ok = del.ok;
      phases.deleteDonor.ms = del.ms;
      if (!del.ok)
        phases.deleteDonor.error = `HTTP ${del.status}: ${(del.body || '').slice(0, 200)}`;
      notes.push(
        `P7 deleteDonor: ${phases.deleteDonor.ok ? 'ok' : 'FAIL'} in ${fmt(phases.deleteDonor.ms)}${!phases.deleteDonor.ok && phases.deleteDonor.error ? ` — ${phases.deleteDonor.error}` : ''}`
      );
    } else {
      phases.deleteDonor.detail = 'skipped — restore failed, donor still load-bearing';
      notes.push(
        `P7 deleteDonor: SKIPPED — restore failed; donor must stay populated for the swapped formula to work`
      );
    }
  } else {
    phases.restoreToLinkFormula.detail = 'skipped (autoRestore=false)';
    phases.deleteDonor.detail = 'skipped (autoRestore=false)';
    notes.push(
      `P6/P7 SKIPPED — column is plain formula → {${donorColumnName}}. Use cleanupSnippet to revert.`
    );
  }

  // ---- Verdict
  let verdict: Test4Result['verdict'];
  if (valuesMatched !== null && valuesMatched === 0) {
    verdict = 'mismatch';
  } else if (!autoRestore) {
    verdict = 'left-frozen';
  } else if (!phases.restoreToLinkFormula.ok) {
    verdict = 'works-but-restore-failed';
  } else if (phases.swapToFormula.ms > 10_000) {
    verdict = 'forward-too-slow';
  } else {
    verdict = 'works';
  }
  notes.push(`verdict: ${verdict}`);
  const total =
    phases.addDonor.ms +
    phases.sqlRead.ms +
    phases.batchPopulate.ms +
    phases.swapToFormula.ms +
    phases.verify.ms +
    phases.restoreToLinkFormula.ms +
    phases.deleteDonor.ms;
  notes.push(`total wall time: ${fmt(total)}`);

  // ---- Cleanup snippet (always provided; useful when restore failed too)
  const cleanupSnippet = donorColumnKey
    ? `// Run if column is still plain formula → {donor} and you want to revert:\n` +
      `const sdk = window.dtableSDK;\n` +
      `const server = window.dtable.server;\n` +
      `const uuid = sdk.config.dtableUuid;\n` +
      `const tok = sdk.config.accessToken;\n` +
      `// 1. Restore link-formula type + original data:\n` +
      `await fetch(\`\${server}/api-gateway/api/v2/dtables/\${uuid}/columns/\`, {\n` +
      `  method: 'PUT',\n` +
      `  headers: { 'content-type': 'application/json', authorization: \`Bearer \${tok}\` },\n` +
      `  body: JSON.stringify({\n` +
      `    op_type: 'modify_column_type',\n` +
      `    table_name: ${JSON.stringify(tableName)},\n` +
      `    column: ${JSON.stringify(linkFormulaColumnKey)},\n` +
      `    new_column_type: 'link-formula',\n` +
      `    column_data: ${JSON.stringify(originalData)},\n` +
      `  }),\n` +
      `});\n` +
      `// 2. Delete the donor column:\n` +
      `await fetch(\`\${server}/api-gateway/api/v2/dtables/\${uuid}/columns/\`, {\n` +
      `  method: 'DELETE',\n` +
      `  headers: { 'content-type': 'application/json', authorization: \`Bearer \${tok}\` },\n` +
      `  body: JSON.stringify({ table_name: ${JSON.stringify(tableName)}, column: ${JSON.stringify(donorColumnKey)} }),\n` +
      `});`
    : '';

  return finalize(verdict, {
    linkFormulaColumnKey,
    donorColumnKey,
    donorColumnType,
    rowCount,
    rowsRead: collected.size,
    rowsWritten: written,
    valuesMatched,
    originalLinkFormula,
    cleanupSnippet,
    column: { tableName, linkFormulaColumnName, donorColumnName },
  });
}

export async function runTest4Console(opts: Test4Opts): Promise<Test4Result> {
  // eslint-disable-next-line no-console
  console.log('[Test4] starting', opts.tableName, '›', opts.linkFormulaColumnName);
  const result = await runTest4({
    ...opts,
    // eslint-disable-next-line no-console
    onProgress: (m) => console.log('[Test4]', m),
  });
  // eslint-disable-next-line no-console
  console.log('[Test4] result', result);
  for (const n of result.notes) {
    // eslint-disable-next-line no-console
    console.log('  ·', n);
  }
  if (result.cleanupSnippet && result.verdict !== 'works') {
    // eslint-disable-next-line no-console
    console.log(
      '\n[Test4] cleanup snippet (in case manual revert needed):\n' + result.cleanupSnippet
    );
  }
  return result;
}

if (typeof window !== 'undefined') {
  (window as any).__perfAuditTest4 = runTest4Console;
}
