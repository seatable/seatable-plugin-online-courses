/**
 * Test 1b — same neutralize-first hypothesis as Test 1, but routes the type
 * change via HTTP `PUT /columns/` instead of the SDK websocket.
 *
 * Why this variant exists — finding from Test 1 on a 69k-row column:
 * dtable-store's `modifyColumnType` synchronously iterates EVERY row in JS
 * to build the `new_rows_data` payload, then ships it through the WS. On a
 * big table this is minutes of JS work *before* the op even leaves the
 * client, and the resulting WS frame is large enough to fail the polling
 * fallback (`413 Payload Too Large` on socket.io). The neutralization step
 * doesn't help with any of that — it's pure client-side overhead independent
 * of the formula's complexity.
 *
 * The HTTP `PUT /columns/` path skips dtable-store entirely. The server is
 * given the metadata change and computes the new column values server-side.
 * If the formula has been neutralized first (Phase 1, still via SDK because
 * `setColumnData` is metadata-only and doesn't iterate rows), there's nothing
 * heavy to compute and the type change should return in seconds. That's the
 * actual production-path-shape the strategy needs.
 *
 * Phases:
 *   0 — Server-health preflight: /metadata/ GET with a 5s budget. Aborts
 *       cleanly if the backend is degraded — no point mutating columns when
 *       the API can't service basic GETs (the 2026-05-12 / 2026-05-20 pattern).
 *   1 — Neutralize via SDK `setColumnData` (cheap, metadata-only).
 *   2 — `modifyColumnType` formula → text via HTTP. Measured by response time.
 *   3 — `modifyColumnType` text → formula with trivial data, via HTTP.
 *   4 — Restore original formula via SDK `setColumnData` (baseline-equivalent).
 *
 * MUTATES A REAL COLUMN. Caller must pass `acknowledgeProduction: true`. Always
 * run on a duplicate / test base.
 */

import { pollMetadataUntilApplied, type ApplyPostCondition } from './performanceAuditRunner';

export interface Test1bOpts {
  dtableSDK: any;
  tableName: string;
  columnName: string;
  accessToken?: string;
  dtableUuid?: string;
  acknowledgeProduction?: boolean;
  onProgress?: (msg: string) => void;
  /** Per-phase timeout for the "should be fast" phases (1, 2, 3). Default 90s. */
  maxFastMs?: number;
  /** Per-phase timeout for the slow restore-data phase (4). Default 30 min. */
  maxSlowMs?: number;
  /** Threshold under which Phase 2 is considered "fast enough" — strategy viable. Default 10s. */
  fastThresholdMs?: number;
  /** Preflight /metadata/ timeout. If exceeded, abort cleanly. Default 5s. */
  preflightMs?: number;
}

export interface TrialResult {
  ok: boolean;
  ms: number;
  error?: string;
}

export type Verdict =
  | 'optimized-fast'
  | 'optimized-slow'
  | 'server-degraded' // preflight failed
  | 'aborted';

export interface Test1bResult {
  column: { tableName: string; columnName: string; columnKey: string; columnKeyAfter: string };
  rowCount: number;
  resultType: string | undefined;
  preflight: TrialResult;
  neutralize: TrialResult;
  optimizedTypeChange: TrialResult; // HTTP
  restoreType: TrialResult; // HTTP
  restoreData: TrialResult; // SDK setColumnData
  verdict: Verdict;
  notes: string[];
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

function neutralFormulaFor(resultType: string | undefined): { formula: string; label: string } {
  switch (resultType) {
    case 'number':
      return { formula: '0', label: '0' };
    case 'bool':
      return { formula: 'FALSE()', label: 'FALSE()' };
    case 'date':
      return { formula: 'today()', label: 'today() [may not be trivial]' };
    case 'string':
    default:
      return { formula: '""', label: '""' };
  }
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
 * Server-health preflight. Times a single /metadata/ GET against a budget.
 * Strict — even a 200 response that took longer than the budget counts as
 * degraded. Saves us from kicking off a test on a backend that will then 504
 * its way through the phases for half an hour.
 */
async function preflightServerHealth(
  uuid: string,
  accessToken: string,
  budgetMs: number
): Promise<{ ok: boolean; ms: number; status: number; error?: string }> {
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';
  const t0 = Date.now();
  const { resp, aborted, error } = await fetchWithTimeout(
    `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/metadata/`,
    {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    },
    budgetMs
  );
  const ms = Date.now() - t0;
  if (aborted) return { ok: false, ms, status: 0, error: `timeout after ${fmt(budgetMs)}` };
  if (error) return { ok: false, ms, status: 0, error };
  if (!resp || !resp.ok)
    return { ok: false, ms, status: resp?.status ?? 0, error: `status ${resp?.status ?? 0}` };
  return { ok: true, ms, status: resp.status };
}

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
      // transient
    }
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 2, 5000);
  }
  return false;
}

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

/**
 * HTTP modify_column_type. Measured by raw HTTP response time — no polling
 * needed because the server's 200 response IS the confirmation. A 504 means
 * nginx → dtable-server timed out at 60s; treat as failure but record the
 * timing (it's still data).
 */
async function httpModifyColumnType(
  uuid: string,
  accessToken: string,
  tableName: string,
  columnKey: string,
  newColumnType: string,
  columnData: any,
  timeoutMs: number
): Promise<{ ok: boolean; ms: number; status: number; body?: string }> {
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';
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

export async function runTest1b(opts: Test1bOpts): Promise<Test1bResult> {
  const {
    dtableSDK,
    tableName,
    columnName,
    acknowledgeProduction = false,
    onProgress,
    maxFastMs = 90 * 1000,
    maxSlowMs = 30 * 60 * 1000,
    fastThresholdMs = 10_000,
    preflightMs = 5_000,
  } = opts;
  const accessToken: string = opts.accessToken || dtableSDK?.config?.accessToken || '';
  const dtableUuid: string = opts.dtableUuid || dtableSDK?.config?.dtableUuid || '';

  const notes: string[] = [];
  const abort = (
    reason: string,
    verdict: Verdict = 'aborted',
    partial?: Partial<Test1bResult>
  ): Test1bResult => ({
    column: { tableName, columnName, columnKey: '', columnKeyAfter: '' },
    rowCount: 0,
    resultType: undefined,
    preflight: { ok: false, ms: 0, error: 'not attempted' },
    neutralize: { ok: false, ms: 0, error: 'not attempted' },
    optimizedTypeChange: { ok: false, ms: 0, error: 'not attempted' },
    restoreType: { ok: false, ms: 0, error: 'not attempted' },
    restoreData: { ok: false, ms: 0, error: 'not attempted' },
    verdict,
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
        `Auto-pull from dtableSDK.config — check opts.dtableSDK.config to verify.`
    );
  }

  // ---- Phase 0: Server-health preflight
  if (onProgress)
    onProgress(
      `Phase 0/4: Server-health preflight (/metadata/ GET, budget ${fmt(preflightMs)})...`
    );
  const preflight = await preflightServerHealth(dtableUuid, accessToken, preflightMs);
  notes.push(
    `Preflight /metadata/: ${preflight.ok ? `ok in ${fmt(preflight.ms)}` : `FAIL in ${fmt(preflight.ms)} (${preflight.error || `status ${preflight.status}`})`}`
  );
  if (!preflight.ok) {
    return abort(
      `server-health preflight failed: ${preflight.error || `status ${preflight.status}`} (took ${fmt(preflight.ms)}, budget ${fmt(preflightMs)}). ` +
        `Backend is degraded — try again later.`,
      'server-degraded',
      { preflight }
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
      `column "${columnName}" is type "${col.type}", expected "formula". Link-formula is Test 2's territory.`
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

  notes.push(
    `column: ${tableName} › ${columnName} (key=${columnKey}, rows=${rowCount}, result_type=${resultType})`
  );
  notes.push(`original formula: ${JSON.stringify(originalData.formula).slice(0, 200)}`);
  notes.push(`neutral formula chosen for result_type=${resultType}: ${neutralLabel}`);

  const neutralize: TrialResult = { ok: false, ms: 0 };
  const optimizedTypeChange: TrialResult = { ok: false, ms: 0 };
  const restoreType: TrialResult = { ok: false, ms: 0 };
  const restoreData: TrialResult = { ok: false, ms: 0 };

  // ---- Phase 1: Neutralize via SDK setColumnData (metadata-only, doesn't iterate rows)
  if (onProgress)
    onProgress(`Phase 1/4: Neutralize via SDK setColumnData (formula → ${neutralLabel})...`);
  const t1 = Date.now();
  try {
    dtableSDK.dtableStore.setColumnData(tableIndex, columnKey, neutralData);
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
  notes.push(
    `P1 neutralize: ${neutralize.ok ? 'ok' : 'FAIL'} in ${fmt(neutralize.ms)}${neutralize.error ? ` — ${neutralize.error}` : ''}`
  );

  if (!neutralize.ok) {
    optimizedTypeChange.error = 'skipped — neutralize failed';
    restoreType.error = 'skipped — neutralize failed';
    notes.push(`skipping Phase 2 + 3 due to Phase 1 failure`);
  } else {
    // ---- Phase 2: HTTP modify_column_type (formula → text)
    if (onProgress) onProgress(`Phase 2/4: HTTP PUT modify_column_type(formula → text)...`);
    const p2 = await httpModifyColumnType(
      dtableUuid,
      accessToken,
      tableName,
      columnKey,
      'text',
      {},
      maxFastMs
    );
    optimizedTypeChange.ok = p2.ok;
    optimizedTypeChange.ms = p2.ms;
    if (!p2.ok) {
      optimizedTypeChange.error = `HTTP ${p2.status}: ${(p2.body || '').slice(0, 200)}`;
    }
    notes.push(
      `P2 opt-type (HTTP): ${optimizedTypeChange.ok ? 'ok' : 'FAIL'} in ${fmt(optimizedTypeChange.ms)} ` +
        `(status ${p2.status})${optimizedTypeChange.error ? ` — ${optimizedTypeChange.error}` : ''}`
    );

    // ---- Phase 3: HTTP modify_column_type (text → formula with trivial data)
    if (optimizedTypeChange.ok) {
      if (onProgress)
        onProgress(`Phase 3/4: HTTP PUT modify_column_type(text → formula, trivial)...`);
      const p3 = await httpModifyColumnType(
        dtableUuid,
        accessToken,
        tableName,
        columnKey,
        'formula',
        neutralData,
        maxFastMs
      );
      restoreType.ok = p3.ok;
      restoreType.ms = p3.ms;
      if (!p3.ok) {
        restoreType.error = `HTTP ${p3.status}: ${(p3.body || '').slice(0, 200)}`;
      }
      notes.push(
        `P3 restore-type (HTTP): ${restoreType.ok ? 'ok' : 'FAIL'} in ${fmt(restoreType.ms)} ` +
          `(status ${p3.status})${restoreType.error ? ` — ${restoreType.error}` : ''}`
      );
    } else {
      restoreType.error = 'skipped — optimized type change failed';
      notes.push(`skipping Phase 3 due to Phase 2 failure`);
    }
  }

  // ---- Phase 4: Restore via SDK setColumnData (slow baseline-equivalent)
  //
  // The column should now be either: formula with trivial data (Phases 2+3 ok),
  // text (Phase 2 ok, Phase 3 failed), or formula with original data (Phase 2
  // failed and the HTTP layer didn't change anything). Branch accordingly.
  const currentCol = await fetchColumn(dtableUuid, accessToken, tableName, columnKey);
  const currentType = currentCol?.type;
  const currentFormula = currentCol?.data?.formula;
  notes.push(
    `pre-P4 column state: type=${currentType}, formula=${JSON.stringify(currentFormula ?? null).slice(0, 80)}`
  );

  if (onProgress)
    onProgress(`Phase 4/4: Restore original formula (slow — re-evaluates ${rowCount} rows)...`);
  const t4 = Date.now();
  try {
    if (currentType === 'text') {
      // Need text → formula with originalData. Use HTTP for the type change to
      // avoid the SDK row-iteration trap. This is the slow baseline-equivalent.
      const p4 = await httpModifyColumnType(
        dtableUuid,
        accessToken,
        tableName,
        columnKey,
        'formula',
        originalData,
        maxSlowMs
      );
      restoreData.ok = p4.ok;
      restoreData.ms = p4.ms;
      if (!p4.ok) restoreData.error = `HTTP ${p4.status}: ${(p4.body || '').slice(0, 200)}`;
    } else if (currentType === 'formula' && currentFormula !== originalData.formula) {
      // Column is formula with trivial data — setColumnData (SDK) to restore.
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
    } else if (currentType === 'formula' && currentFormula === originalData.formula) {
      // Already at originalData (Phase 2 failed before mutating, or some sync
      // restored it). Nothing to do — mark ok, ms=0.
      restoreData.ok = true;
      restoreData.ms = 0;
      notes.push(`P4 no-op — column already at originalData`);
    } else {
      restoreData.error = `unexpected column type "${currentType}" — manual recovery needed`;
    }
  } catch (e: any) {
    restoreData.error = e?.message || String(e);
  }
  restoreData.ms = restoreData.ms || Date.now() - t4;
  notes.push(
    `P4 restore-data: ${restoreData.ok ? 'ok' : 'FAIL'} in ${fmt(restoreData.ms)}${restoreData.error ? ` — ${restoreData.error}` : ''}`
  );

  // ---- Final sanity
  const finalCol = await fetchColumn(dtableUuid, accessToken, tableName, columnKey);
  const columnKeyAfter = finalCol?.key || '';
  if (columnKeyAfter !== columnKey) {
    notes.push(`WARNING: column_key changed during test: ${columnKey} → ${columnKeyAfter}.`);
  } else if (finalCol) {
    notes.push(
      `final state: type=${finalCol.type}, formula=${JSON.stringify(finalCol?.data?.formula ?? null).slice(0, 80)} — key preserved ✓`
    );
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

  if (restoreData.ok && optimizedTypeChange.ok && restoreData.ms > 0) {
    const ratio = restoreData.ms / Math.max(1, neutralize.ms + optimizedTypeChange.ms);
    notes.push(
      `speedup vs baseline-equivalent (Phase 4): ${ratio.toFixed(1)}× (${fmt(restoreData.ms)} → ${fmt(neutralize.ms + optimizedTypeChange.ms)})`
    );
  }

  return {
    column: { tableName, columnName, columnKey, columnKeyAfter },
    rowCount,
    resultType,
    preflight: { ok: preflight.ok, ms: preflight.ms, error: preflight.error },
    neutralize,
    optimizedTypeChange,
    restoreType,
    restoreData,
    verdict,
    notes,
  };
}

export async function runTest1bConsole(opts: Test1bOpts): Promise<Test1bResult> {
  // eslint-disable-next-line no-console
  console.log('[Test1b] starting', opts.tableName, '›', opts.columnName);
  const result = await runTest1b({
    ...opts,
    // eslint-disable-next-line no-console
    onProgress: (m) => console.log('[Test1b]', m),
  });
  // eslint-disable-next-line no-console
  console.log('[Test1b] result', result);
  for (const n of result.notes) {
    // eslint-disable-next-line no-console
    console.log('  ·', n);
  }
  return result;
}

if (typeof window !== 'undefined') {
  (window as any).__perfAuditTest1b = runTest1bConsole;
}

// Suppress unused import warning — pollMetadataUntilApplied is kept available
// for any future variant that wants to assert post-conditions across multiple
// columns or views; current phases use single-column pollColumnPredicate.
void pollMetadataUntilApplied;
void ({} as ApplyPostCondition);
