/**
 * Test 1 — validate the neutralize-first hypothesis for modifyColumnType.
 *
 * Hypothesis: modifyColumnType is slow on formula columns because the server has
 * to compute and persist final values for every row. If we first neutralize the
 * formula (setColumnData → '""', operated_columns: []), the subsequent type
 * change has trivial values to freeze and should complete in seconds, not minutes.
 *
 * IMPORTANT — modifyColumnType signature gotcha:
 *   dtableStore.modifyColumnType(tableIndex, columnKey, newColumnSpec, collaborators?)
 *   newColumnSpec is { type, name, data } — NOT just a type string. The dtable-store
 *   helper destructures it; passing a bare string yields type=name=undefined,
 *   which makes the server null out the column metadata entirely (corrupted column,
 *   no name, no type). The 4th arg is collaborators, not data — passing data there
 *   is silently ignored. See updateColumnAndColumnRowsData in dtable-store bundle.
 *
 * Trial structure (the column ends in the same state it started in):
 *   Phase 1 — Neutralize:           setColumnData(formula → '""')           [measured: should be fast]
 *   Phase 2 — Optimized type change: modifyColumnType(formula → text)        [measured: should be fast]
 *   Phase 3 — Restore type:          modifyColumnType(text → formula trivial) [measured: should be fast]
 *   Phase 4 — Restore data:          setColumnData('""' → original formula)   [measured: BASELINE-equivalent — likely slow]
 *
 * Phases 1–3 are the optimized path under test. Phase 4 IS effectively the
 * baseline: putting the original heavy formula back on a 50k-row column triggers
 * the same server-side re-evaluation that baseline modifyColumnType does. We
 * report it separately so the caller has an apples-to-apples comparison from a
 * single trial run, with no second slow restoration cycle.
 *
 * MUTATES A REAL COLUMN. Caller must pass `acknowledgeProduction: true`. Always
 * run on a duplicate / test base, never on a production base with live consumers.
 */

import { pollMetadataUntilApplied, type ApplyPostCondition } from './performanceAuditRunner';

export interface Test1Opts {
  dtableSDK: any;
  tableName: string;
  columnName: string;
  /** Optional — pulled from dtableSDK.config.accessToken if omitted. */
  accessToken?: string;
  /** Optional — pulled from dtableSDK.config.dtableUuid if omitted. */
  dtableUuid?: string;
  acknowledgeProduction?: boolean;
  onProgress?: (msg: string) => void;
  /** Per-phase timeout for the "should be fast" phases (1, 2, 3). Default 60s. */
  maxFastMs?: number;
  /** Per-phase timeout for the slow restore-data phase (4) and any reluctant type change. Default 30 min. */
  maxSlowMs?: number;
  /** Threshold under which the optimized type-change is considered "fast enough" for the strategy to be viable. Default 10s. */
  fastThresholdMs?: number;
}

export interface TrialResult {
  ok: boolean;
  ms: number;
  error?: string;
}

export type Verdict =
  | 'optimized-fast' // Phase 1 + 2 succeeded and Phase 2 was under threshold → strategy viable
  | 'optimized-slow' // Phase 1 + 2 succeeded but Phase 2 was over threshold → strategy not viable as-is
  | 'aborted'; // pre-flight or an essential phase failed

export interface Test1Result {
  column: { tableName: string; columnName: string; columnKey: string; columnKeyAfter: string };
  rowCount: number;
  resultType: string | undefined;
  neutralize: TrialResult;
  optimizedTypeChange: TrialResult;
  restoreType: TrialResult;
  restoreData: TrialResult; // baseline-equivalent (slow path)
  verdict: Verdict;
  notes: string[];
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

/**
 * Pick a trivial formula expression whose evaluated type matches the column's
 * existing result_type. The server likely validates expression-type-vs-result-type
 * consistency on `modify_column_data` ops and silently rejects mismatches via
 * websocket (the SDK doesn't surface that as an exception). Empirical: passing
 * '""' against a result_type='number' column produces a no-op server-side.
 */
function neutralFormulaFor(resultType: string | undefined): { formula: string; label: string } {
  switch (resultType) {
    case 'number':
      return { formula: '0', label: '0' };
    case 'bool':
      return { formula: 'FALSE()', label: 'FALSE()' };
    case 'date':
      // No safe constant-date expression — TODAY()/NOW() still recompute per row,
      // defeating the "trivial" premise. Caller should skip date-result columns.
      return { formula: 'today()', label: 'today() [may not be trivial]' };
    case 'string':
    default:
      return { formula: '""', label: '""' };
  }
}

/**
 * Fast-cadence column predicate poll. Used for the "should be quick" phases
 * (neutralize, restore-type) where pollMetadataUntilApplied's 1s starting delay
 * is too coarse. Schedule: 200ms → 400ms → 800ms → 1.6s → 3.2s → 5s (capped).
 */
async function pollColumnPredicate(
  uuid: string,
  accessToken: string,
  tableName: string,
  columnKey: string,
  predicate: (col: any) => boolean,
  maxTotalMs: number,
  onProgress?: (msg: string) => void,
  label = 'change'
): Promise<boolean> {
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';
  const start = Date.now();
  let delayMs = 200;
  while (Date.now() - start < maxTotalMs) {
    if (onProgress) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      onProgress(`Polling for ${label} (${elapsed}s)...`);
    }
    try {
      // cache: 'no-store' suppresses If-None-Match on repeat polls. Without it
      // the server returns 304, resp.ok is false, the body is never read, and
      // the predicate never matches the post-op state. (A Cache-Control header
      // would also work but is blocked by the api-gateway's CORS allowlist.)
      const resp = await fetch(`${serverUrl}/api-gateway/api/v2/dtables/${uuid}/metadata/`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      });
      if (resp.ok) {
        const data = await resp.json();
        const tables: any[] = data?.metadata?.tables || data?.tables || [];
        const tbl = tables.find((t: any) => t.name === tableName);
        const col = tbl ? (tbl.columns || []).find((c: any) => c.key === columnKey) : null;
        if (col && predicate(col)) return true;
      }
    } catch {
      // transient — keep going
    }
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 2, 5000);
  }
  return false;
}

/** Look up the latest server-side column shape (post-test sanity read). */
async function fetchColumn(
  uuid: string,
  accessToken: string,
  tableName: string,
  columnKey: string
): Promise<any | null> {
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';
  try {
    const resp = await fetch(`${serverUrl}/api-gateway/api/v2/dtables/${uuid}/metadata/`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const tables: any[] = data?.metadata?.tables || data?.tables || [];
    const tbl = tables.find((t: any) => t.name === tableName);
    return tbl ? (tbl.columns || []).find((c: any) => c.key === columnKey) || null : null;
  } catch {
    return null;
  }
}

export async function runTest1(opts: Test1Opts): Promise<Test1Result> {
  const {
    dtableSDK,
    tableName,
    columnName,
    acknowledgeProduction = false,
    onProgress,
    maxFastMs = 60 * 1000,
    maxSlowMs = 30 * 60 * 1000,
    fastThresholdMs = 10_000,
  } = opts;
  // The SDK keeps these on its config (set during init from app-access-token).
  // window.dtable only carries server + lang in this plugin host.
  const accessToken: string = opts.accessToken || dtableSDK?.config?.accessToken || '';
  const dtableUuid: string = opts.dtableUuid || dtableSDK?.config?.dtableUuid || '';

  const notes: string[] = [];
  const abort = (reason: string, partial?: Partial<Test1Result>): Test1Result => ({
    column: { tableName, columnName, columnKey: '', columnKeyAfter: '' },
    rowCount: 0,
    resultType: undefined,
    neutralize: { ok: false, ms: 0, error: 'not attempted' },
    optimizedTypeChange: { ok: false, ms: 0, error: 'not attempted' },
    restoreType: { ok: false, ms: 0, error: 'not attempted' },
    restoreData: { ok: false, ms: 0, error: 'not attempted' },
    verdict: 'aborted',
    notes: [...notes, `aborted: ${reason}`],
    ...partial,
  });

  if (!acknowledgeProduction) {
    return abort(
      'pass acknowledgeProduction: true to confirm this mutates a real column. Always run on a duplicate / test base.'
    );
  }
  if (!accessToken || !dtableUuid) {
    return abort(
      `missing accessToken (${accessToken ? 'ok' : 'EMPTY'}) or dtableUuid (${dtableUuid ? 'ok' : 'EMPTY'}). ` +
        `These auto-pull from dtableSDK.config — if your SDK reference is wrong they'll be empty. ` +
        `Try opts.dtableSDK.config to verify.`
    );
  }

  // ---- Pre-flight: locate column, capture original data
  const tables: any[] = dtableSDK.getTables();
  const tableIndex = tables.findIndex((t: any) => t.name === tableName);
  if (tableIndex < 0) return abort(`table "${tableName}" not found`);
  const tbl = tables[tableIndex];
  const col = (tbl.columns || []).find((c: any) => c.name === columnName);
  if (!col) return abort(`column "${columnName}" not found in "${tableName}"`);
  if (col.type !== 'formula') {
    return abort(
      `column "${columnName}" is type "${col.type}", expected "formula". Link-formula columns are Test 2's territory.`
    );
  }

  const columnKey: string = col.key;
  const originalData = JSON.parse(JSON.stringify(col.data || {}));
  if (originalData.formula === undefined) {
    return abort(`column "${columnName}" has no .data.formula — unexpected shape`);
  }
  const resultType: string | undefined = originalData.result_type;
  const { formula: neutralFormula, label: neutralLabel } = neutralFormulaFor(resultType);
  if (originalData.formula === neutralFormula) {
    return abort(
      `column "${columnName}" already has neutral formula ${neutralLabel} — nothing to neutralize from`
    );
  }
  const rowCount = (tbl.rows || []).length;
  const neutralData = { ...originalData, formula: neutralFormula, operated_columns: [] };

  notes.push(`column: ${tableName} › ${columnName} (key=${columnKey}, rows=${rowCount}, result_type=${resultType})`);
  notes.push(`original formula: ${JSON.stringify(originalData.formula).slice(0, 200)}`);
  notes.push(`neutral formula chosen for result_type=${resultType}: ${neutralLabel}`);

  const neutralize: TrialResult = { ok: false, ms: 0 };
  const optimizedTypeChange: TrialResult = { ok: false, ms: 0 };
  const restoreType: TrialResult = { ok: false, ms: 0 };
  const restoreData: TrialResult = { ok: false, ms: 0 };

  // ---- Phase 1: Neutralize via setColumnData
  if (onProgress) onProgress(`Phase 1/4: Neutralize via setColumnData (formula → ${neutralLabel})...`);
  const t1 = Date.now();
  try {
    dtableSDK.dtableStore.setColumnData(tableIndex, columnKey, neutralData);
    // Diagnostic — read SDK local state right after the op so we can tell whether
    // the SDK accepted it locally (server-side rejection only) vs refused locally
    // (the call did nothing at all).
    const sdkColAfter = (dtableSDK.getTables()?.[tableIndex]?.columns || []).find(
      (c: any) => c.key === columnKey
    );
    notes.push(
      `P1 SDK local state after setColumnData: formula=${JSON.stringify(sdkColAfter?.data?.formula)} ` +
        `(expected ${JSON.stringify(neutralFormula)})`
    );
    const ok = await pollColumnPredicate(
      dtableUuid,
      accessToken,
      tableName,
      columnKey,
      (c) => c?.type === 'formula' && c?.data?.formula === neutralFormula,
      maxFastMs,
      (m) => onProgress?.(`P1 neutralize: ${m}`),
      'neutralize'
    );
    neutralize.ok = ok;
    if (!ok) neutralize.error = `timeout after ${fmt(maxFastMs)}`;
  } catch (e: any) {
    neutralize.error = e?.message || String(e);
  }
  neutralize.ms = Date.now() - t1;
  notes.push(`P1 neutralize: ${neutralize.ok ? 'ok' : 'FAIL'} in ${fmt(neutralize.ms)}${neutralize.error ? ` — ${neutralize.error}` : ''}`);

  // If neutralize failed we can't sensibly run the rest. Skip to slow data restore.
  if (!neutralize.ok) {
    optimizedTypeChange.error = 'skipped — neutralize failed';
    restoreType.error = 'skipped — neutralize failed';
    notes.push(`skipping Phase 2 + 3 due to Phase 1 failure`);
  } else {
    // ---- Phase 2: Optimized type change (formula → text) while neutral
    if (onProgress) onProgress(`Phase 2/4: modifyColumnType(formula → text) on neutralized column...`);
    const t2 = Date.now();
    try {
      // Correct signature: newColumnSpec object (NOT a bare type string), no 4th arg.
      dtableSDK.dtableStore.modifyColumnType(tableIndex, columnKey, {
        type: 'text',
        name: columnName,
        data: {},
      });
      // Safety check — read SDK local state immediately. If name or type went
      // undefined locally, the call was still malformed: abort before the malformed
      // op reaches the server and corrupts the column server-side.
      const sdkColAfterP2 = (dtableSDK.getTables()?.[tableIndex]?.columns || []).find(
        (c: any) => c.key === columnKey
      );
      notes.push(
        `P2 SDK local state after modifyColumnType: ` +
          `type=${JSON.stringify(sdkColAfterP2?.type)}, ` +
          `name=${JSON.stringify(sdkColAfterP2?.name)}`
      );
      if (!sdkColAfterP2?.type || !sdkColAfterP2?.name) {
        throw new Error(
          `SDK local state corrupted (type=${sdkColAfterP2?.type}, name=${sdkColAfterP2?.name}). ` +
            `Aborting before op reaches the server.`
        );
      }
      const cond: ApplyPostCondition = { kind: 'columnType', tableName, columnKey, expectedType: 'text' };
      const result = await pollMetadataUntilApplied(
        dtableUuid,
        accessToken,
        [cond],
        (m) => onProgress?.(`P2 opt-type: ${m}`),
        maxFastMs
      );
      optimizedTypeChange.ok = result.done;
      if (!result.done) optimizedTypeChange.error = `timeout after ${fmt(maxFastMs)}`;
    } catch (e: any) {
      optimizedTypeChange.error = e?.message || String(e);
    }
    optimizedTypeChange.ms = Date.now() - t2;
    notes.push(`P2 opt-type:    ${optimizedTypeChange.ok ? 'ok' : 'FAIL'} in ${fmt(optimizedTypeChange.ms)}${optimizedTypeChange.error ? ` — ${optimizedTypeChange.error}` : ''}`);

    // ---- Phase 3: Restore type (text → formula with trivial data)
    if (optimizedTypeChange.ok) {
      if (onProgress) onProgress(`Phase 3/4: modifyColumnType(text → formula, trivial)...`);
      const t3 = Date.now();
      try {
        dtableSDK.dtableStore.modifyColumnType(tableIndex, columnKey, {
          type: 'formula',
          name: columnName,
          data: neutralData,
        });
        const cond: ApplyPostCondition = { kind: 'columnType', tableName, columnKey, expectedType: 'formula' };
        const result = await pollMetadataUntilApplied(
          dtableUuid,
          accessToken,
          [cond],
          (m) => onProgress?.(`P3 restore-type: ${m}`),
          maxFastMs
        );
        restoreType.ok = result.done;
        if (!result.done) restoreType.error = `timeout after ${fmt(maxFastMs)}`;
      } catch (e: any) {
        restoreType.error = e?.message || String(e);
      }
      restoreType.ms = Date.now() - t3;
      notes.push(`P3 restore-type: ${restoreType.ok ? 'ok' : 'FAIL'} in ${fmt(restoreType.ms)}${restoreType.error ? ` — ${restoreType.error}` : ''}`);
    } else {
      restoreType.error = 'skipped — optimized type change failed';
      notes.push(`skipping Phase 3 due to Phase 2 failure`);
    }
  }

  // ---- Phase 4: Restore data (setColumnData → original formula) — BASELINE-equivalent slow path
  //
  // Whatever state the column is in now (formula '""' if we got through Phase 3,
  // or text if Phase 2 succeeded but Phase 3 failed, or formula '""' if Phase 2
  // failed), we need to land on formula with originalData. Branch accordingly.
  const currentCol = await fetchColumn(dtableUuid, accessToken, tableName, columnKey);
  const currentType = currentCol?.type;
  notes.push(`pre-P4 column state: type=${currentType}, formula=${JSON.stringify(currentCol?.data?.formula ?? null).slice(0, 80)}`);

  if (onProgress) onProgress(`Phase 4/4: Restore original formula (slow — re-evaluates ${rowCount} rows)...`);
  const t4 = Date.now();
  try {
    if (currentType === 'text') {
      // Need to go text → formula with originalData directly. This is the slow,
      // baseline-equivalent path: the server has to evaluate the formula for every row.
      dtableSDK.dtableStore.modifyColumnType(tableIndex, columnKey, {
        type: 'formula',
        name: columnName,
        data: originalData,
      });
      const cond: ApplyPostCondition = { kind: 'columnType', tableName, columnKey, expectedType: 'formula' };
      const result = await pollMetadataUntilApplied(
        dtableUuid,
        accessToken,
        [cond],
        (m) => onProgress?.(`P4 restore-data (text→formula): ${m}`),
        maxSlowMs
      );
      restoreData.ok = result.done;
      if (!result.done) restoreData.error = `timeout after ${fmt(maxSlowMs)}`;
    } else if (currentType === 'formula') {
      // Column is formula with trivial data — setColumnData to restore the original.
      // This triggers full re-evaluation: the slow baseline-equivalent.
      dtableSDK.dtableStore.setColumnData(tableIndex, columnKey, originalData);
      const ok = await pollColumnPredicate(
        dtableUuid,
        accessToken,
        tableName,
        columnKey,
        (c) => c?.type === 'formula' && c?.data?.formula === originalData.formula,
        maxSlowMs,
        (m) => onProgress?.(`P4 restore-data (setColumnData): ${m}`),
        'restore-data'
      );
      restoreData.ok = ok;
      if (!ok) restoreData.error = `timeout after ${fmt(maxSlowMs)}`;
    } else {
      restoreData.error = `unexpected column type "${currentType}" — manual recovery needed`;
    }
  } catch (e: any) {
    restoreData.error = e?.message || String(e);
  }
  restoreData.ms = Date.now() - t4;
  notes.push(`P4 restore-data: ${restoreData.ok ? 'ok' : 'FAIL'} in ${fmt(restoreData.ms)}${restoreData.error ? ` — ${restoreData.error}` : ''}`);

  // ---- Final sanity: confirm column_key survived end-to-end
  const finalCol = await fetchColumn(dtableUuid, accessToken, tableName, columnKey);
  const columnKeyAfter = finalCol?.key || '';
  if (columnKeyAfter !== columnKey) {
    notes.push(`WARNING: column_key changed during test: ${columnKey} → ${columnKeyAfter}. Downstream-reference preservation hypothesis is INVALID.`);
  } else if (finalCol) {
    notes.push(`final state: type=${finalCol.type}, formula=${JSON.stringify(finalCol?.data?.formula ?? null).slice(0, 80)} — key preserved ✓`);
  }

  // ---- Verdict
  let verdict: Verdict;
  if (!neutralize.ok || !optimizedTypeChange.ok) {
    verdict = 'aborted';
  } else if (optimizedTypeChange.ms < fastThresholdMs) {
    verdict = 'optimized-fast';
  } else {
    verdict = 'optimized-slow';
  }
  notes.push(`verdict: ${verdict} (threshold ${fmt(fastThresholdMs)})`);

  if (restoreData.ok && optimizedTypeChange.ok) {
    const ratio = restoreData.ms / Math.max(1, neutralize.ms + optimizedTypeChange.ms);
    notes.push(`speedup vs baseline-equivalent (Phase 4): ${ratio.toFixed(1)}× (${fmt(restoreData.ms)} → ${fmt(neutralize.ms + optimizedTypeChange.ms)})`);
  }

  return {
    column: { tableName, columnName, columnKey, columnKeyAfter },
    rowCount,
    resultType,
    neutralize,
    optimizedTypeChange,
    restoreType,
    restoreData,
    verdict,
    notes,
  };
}

/** Console wrapper: streams progress to console and prints a structured summary. */
export async function runTest1Console(opts: Test1Opts): Promise<Test1Result> {
  // eslint-disable-next-line no-console
  console.log('[Test1] starting', opts.tableName, '›', opts.columnName);
  const result = await runTest1({
    ...opts,
    // eslint-disable-next-line no-console
    onProgress: (m) => console.log('[Test1]', m),
  });
  // eslint-disable-next-line no-console
  console.log('[Test1] result', result);
  for (const n of result.notes) {
    // eslint-disable-next-line no-console
    console.log('  ·', n);
  }
  return result;
}

if (typeof window !== 'undefined') {
  (window as any).__perfAuditTest1 = runTest1Console;
}
