/**
 * Test 2 — verify the indirection-via-donor-column approach.
 *
 * The strategy: keep a heavy formula column's identity intact (same key,
 * same name) but swap its formula expression to a trivial `{DonorColumn}`
 * reference. The donor holds the pre-computed values (populated separately
 * via batch_update_rows). Net effect: downstream references continue to
 * read the original column and get cheap snapshot values without any
 * rewiring.
 *
 * Test 2 verifies the *mechanism*, not the scaling:
 *   1. Can `setColumnData` swap a formula column's expression to `{Donor}`?
 *   2. Does the op stay cheap (metadata-only, no eager full-table evaluation)?
 *   3. Do the column's displayed values become the donor's values?
 *   4. Is restoration as cheap as the forward swap?
 *
 * Bring your own donor column — any existing plain-typed column (text,
 * number, etc.) on the same table works. Use a small table for the first
 * run; scaling validation is a separate exercise.
 *
 * MUTATES A REAL COLUMN. Caller must pass `acknowledgeProduction: true`.
 */

interface TrialResult {
  ok: boolean;
  ms: number;
  error?: string;
}

export interface Test2Opts {
  dtableSDK: any;
  tableName: string;
  /** Formula column whose expression we'll swap and then restore. */
  formulaColumnName: string;
  /** Plain-typed column on the same table whose values the formula will reference. */
  donorColumnName: string;
  acknowledgeProduction?: boolean;
  accessToken?: string;
  dtableUuid?: string;
  onProgress?: (msg: string) => void;
  /** Per-phase timeout for "should be fast" phases. Default 60s. */
  maxFastMs?: number;
}

export interface Test2Result {
  column: { tableName: string; formulaColumnName: string; donorColumnName: string };
  formulaColumnKey: string;
  donorColumnKey: string;
  donorColumnType: string;
  rowCount: number;
  swap: TrialResult; // setColumnData to {donor} reference
  sample: TrialResult; // SQL fetch a few rows + value comparison
  restore: TrialResult; // setColumnData back to original formula
  valuesMatched: number | null; // out of N sampled rows, how many matched donor
  verdict: 'works' | 'works-but-slow' | 'mismatch' | 'aborted';
  notes: string[];
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
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

/**
 * Sample N rows via SQL and compare values across the two columns.
 *
 * SeaTable SQL responses key row data by column KEY (e.g. "taX5"), not name.
 * The response includes a separate `metadata` array mapping name ↔ key. We
 * resolve column keys from there, then read row values by key. A raw shape
 * dump goes into the result so the caller can see what's actually coming
 * back if anything's off.
 */
async function sampleAndCompare(
  uuid: string,
  accessToken: string,
  tableName: string,
  formulaColName: string,
  donorColName: string,
  limit: number
): Promise<{
  ok: boolean;
  matched: number;
  total: number;
  sample: any[];
  rawShape?: string;
  error?: string;
}> {
  const config = (window as any).dtable || {};
  const serverUrl = config.server || '';
  try {
    const resp = await fetch(`${serverUrl}/api-gateway/api/v2/dtables/${uuid}/sql/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        sql: `SELECT \`${formulaColName}\`, \`${donorColName}\` FROM \`${tableName}\` LIMIT ${limit}`,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { ok: false, matched: 0, total: 0, sample: [], error: `SQL HTTP ${resp.status}: ${body.slice(0, 200)}` };
    }
    const data = await resp.json();
    const rows: any[] = data?.results || data?.rows || [];
    const meta: any[] = data?.metadata || data?.columns || [];
    // Resolve real keys for the columns in case rows are keyed by column.key.
    const findKey = (name: string): string | null => {
      const m = meta.find((x: any) => x.name === name || x.column_name === name);
      return m?.key || m?.column_key || null;
    };
    const fKey = findKey(formulaColName);
    const dKey = findKey(donorColName);
    const rawShape = `metadata keys: ${meta.map((m: any) => `${m.name || m.column_name}→${m.key || m.column_key}`).join(', ') || 'EMPTY'} | first row keys: ${rows[0] ? Object.keys(rows[0]).join(',') : 'NO ROWS'}`;
    if (rows.length === 0) {
      return { ok: true, matched: 0, total: 0, sample: [], rawShape };
    }
    // Try multiple key strategies (by name, by resolved key) to survive
    // SeaTable response variations.
    const getF = (r: any) => (fKey && r[fKey] !== undefined ? r[fKey] : r[formulaColName]);
    const getD = (r: any) => (dKey && r[dKey] !== undefined ? r[dKey] : r[donorColName]);
    let matched = 0;
    for (const r of rows) {
      const f = getF(r);
      const d = getD(r);
      // Count as match only if BOTH are defined and equal (loose).
      if (f === undefined && d === undefined) continue;
      if (f === d || String(f ?? '') === String(d ?? '')) matched++;
    }
    return { ok: true, matched, total: rows.length, sample: rows, rawShape };
  } catch (e: any) {
    return { ok: false, matched: 0, total: 0, sample: [], error: e?.message || String(e) };
  }
}

export async function runTest2(opts: Test2Opts): Promise<Test2Result> {
  const {
    dtableSDK,
    tableName,
    formulaColumnName,
    donorColumnName,
    acknowledgeProduction = false,
    onProgress,
    maxFastMs = 60 * 1000,
  } = opts;
  const accessToken: string = opts.accessToken || dtableSDK?.config?.accessToken || '';
  const dtableUuid: string = opts.dtableUuid || dtableSDK?.config?.dtableUuid || '';

  const notes: string[] = [];
  const abort = (reason: string): Test2Result => ({
    column: { tableName, formulaColumnName, donorColumnName },
    formulaColumnKey: '',
    donorColumnKey: '',
    donorColumnType: '',
    rowCount: 0,
    swap: { ok: false, ms: 0, error: 'not attempted' },
    sample: { ok: false, ms: 0, error: 'not attempted' },
    restore: { ok: false, ms: 0, error: 'not attempted' },
    valuesMatched: null,
    verdict: 'aborted',
    notes: [...notes, `aborted: ${reason}`],
  });

  if (!acknowledgeProduction) {
    return abort('pass acknowledgeProduction: true to confirm this mutates a real column. Use a test base.');
  }
  if (!accessToken || !dtableUuid) {
    return abort(`missing auth: accessToken ${accessToken ? 'ok' : 'EMPTY'}, dtableUuid ${dtableUuid ? 'ok' : 'EMPTY'}`);
  }

  // ---- Pre-flight: locate both columns
  const tables: any[] = dtableSDK.getTables();
  const tableIndex = tables.findIndex((t: any) => t.name === tableName);
  if (tableIndex < 0) return abort(`table "${tableName}" not found`);
  const tbl = tables[tableIndex];
  const formulaCol = (tbl.columns || []).find((c: any) => c.name === formulaColumnName);
  const donorCol = (tbl.columns || []).find((c: any) => c.name === donorColumnName);
  if (!formulaCol) return abort(`formula column "${formulaColumnName}" not found in "${tableName}"`);
  if (!donorCol) return abort(`donor column "${donorColumnName}" not found in "${tableName}"`);
  if (formulaCol.type !== 'formula') {
    return abort(`"${formulaColumnName}" is type "${formulaCol.type}", expected "formula"`);
  }
  if (donorCol.type === 'formula' || donorCol.type === 'link-formula' || donorCol.type === 'link') {
    return abort(
      `donor "${donorColumnName}" is type "${donorCol.type}". Donor must be plain (text/number/date/etc.) to be a stable indirection target.`
    );
  }

  const formulaColumnKey: string = formulaCol.key;
  const donorColumnKey: string = donorCol.key;
  const donorColumnType: string = donorCol.type;
  const originalData = JSON.parse(JSON.stringify(formulaCol.data || {}));
  const rowCount = (tbl.rows || []).length;

  // Build the donor-reference formula data. Curly-brace syntax references by name.
  const donorRefData = {
    ...originalData,
    formula: `{${donorColumnName}}`,
    operated_columns: [donorColumnKey],
  };

  notes.push(
    `formula column: ${tableName} › ${formulaColumnName} (key=${formulaColumnKey}, rows=${rowCount})`
  );
  notes.push(`donor column: ${donorColumnName} (key=${donorColumnKey}, type=${donorColumnType})`);
  notes.push(`original formula: ${JSON.stringify(originalData.formula).slice(0, 200)}`);
  notes.push(`new formula (proposed): ${JSON.stringify(donorRefData.formula)}`);

  const swap: TrialResult = { ok: false, ms: 0 };
  const sample: TrialResult = { ok: false, ms: 0 };
  const restore: TrialResult = { ok: false, ms: 0 };
  let valuesMatched: number | null = null;

  // ---- Phase 1: Swap formula → {donor}
  if (onProgress) onProgress(`Phase 1/3: setColumnData(formula → {${donorColumnName}})...`);
  const t1 = Date.now();
  try {
    dtableSDK.dtableStore.setColumnData(tableIndex, formulaColumnKey, donorRefData);
    const sdkColAfter = (dtableSDK.getTables()?.[tableIndex]?.columns || []).find(
      (c: any) => c.key === formulaColumnKey
    );
    notes.push(
      `swap SDK local state: type=${JSON.stringify(sdkColAfter?.type)}, ` +
        `formula=${JSON.stringify(sdkColAfter?.data?.formula)}`
    );
    if (sdkColAfter?.type !== 'formula' || sdkColAfter?.data?.formula !== donorRefData.formula) {
      throw new Error(`SDK local state didn't accept the swap`);
    }
    const ok = await pollColumnPredicate(
      dtableUuid,
      accessToken,
      tableName,
      formulaColumnKey,
      (c) => c?.type === 'formula' && c?.data?.formula === donorRefData.formula,
      maxFastMs,
      (m) => onProgress?.(`swap: ${m}`),
      'swap'
    );
    swap.ok = ok;
    if (!ok) swap.error = `timeout after ${fmt(maxFastMs)}`;
  } catch (e: any) {
    swap.error = e?.message || String(e);
  }
  swap.ms = Date.now() - t1;
  notes.push(`swap: ${swap.ok ? 'ok' : 'FAIL'} in ${fmt(swap.ms)}${swap.error ? ` — ${swap.error}` : ''}`);

  // ---- Phase 2: Sample values via SQL to verify the indirection actually shows donor's values
  if (swap.ok) {
    if (onProgress) onProgress(`Phase 2/3: Sampling 10 rows via SQL...`);
    const t2 = Date.now();
    const cmp = await sampleAndCompare(
      dtableUuid,
      accessToken,
      tableName,
      formulaColumnName,
      donorColumnName,
      10
    );
    sample.ms = Date.now() - t2;
    sample.ok = cmp.ok;
    if (!cmp.ok) sample.error = cmp.error;
    valuesMatched = cmp.ok ? cmp.matched : null;
    notes.push(
      `sample: ${sample.ok ? 'ok' : 'FAIL'} in ${fmt(sample.ms)} — ` +
        `${cmp.matched}/${cmp.total} rows have matching values across both columns` +
        `${sample.error ? ` (${sample.error})` : ''}`
    );
    if (cmp.rawShape) notes.push(`sample raw shape: ${cmp.rawShape}`);
    if (cmp.ok && cmp.sample.length > 0) {
      notes.push(`sample preview (first 3 raw rows): ${JSON.stringify(cmp.sample.slice(0, 3)).slice(0, 400)}`);
    }
  } else {
    sample.error = 'skipped — swap failed';
  }

  // ---- Phase 3: Restore original formula
  if (onProgress) onProgress(`Phase 3/3: Restoring original formula...`);
  const t3 = Date.now();
  try {
    dtableSDK.dtableStore.setColumnData(tableIndex, formulaColumnKey, originalData);
    const ok = await pollColumnPredicate(
      dtableUuid,
      accessToken,
      tableName,
      formulaColumnKey,
      (c) => c?.type === 'formula' && c?.data?.formula === originalData.formula,
      maxFastMs,
      (m) => onProgress?.(`restore: ${m}`),
      'restore'
    );
    restore.ok = ok;
    if (!ok) restore.error = `timeout after ${fmt(maxFastMs)}`;
  } catch (e: any) {
    restore.error = e?.message || String(e);
  }
  restore.ms = Date.now() - t3;
  notes.push(
    `restore: ${restore.ok ? 'ok' : 'FAIL'} in ${fmt(restore.ms)}${restore.error ? ` — ${restore.error}` : ''}`
  );

  // ---- Verdict
  let verdict: Test2Result['verdict'];
  if (!swap.ok || !sample.ok || !restore.ok) {
    verdict = 'aborted';
  } else if (valuesMatched !== null && valuesMatched === 0) {
    verdict = 'mismatch';
  } else if (swap.ms > 3000) {
    verdict = 'works-but-slow';
  } else {
    verdict = 'works';
  }
  notes.push(`verdict: ${verdict}`);

  return {
    column: { tableName, formulaColumnName, donorColumnName },
    formulaColumnKey,
    donorColumnKey,
    donorColumnType,
    rowCount,
    swap,
    sample,
    restore,
    valuesMatched,
    verdict,
    notes,
  };
}

export async function runTest2Console(opts: Test2Opts): Promise<Test2Result> {
  // eslint-disable-next-line no-console
  console.log('[Test2] starting', opts.tableName, '›', opts.formulaColumnName, '→', `{${opts.donorColumnName}}`);
  const result = await runTest2({
    ...opts,
    // eslint-disable-next-line no-console
    onProgress: (m) => console.log('[Test2]', m),
  });
  // eslint-disable-next-line no-console
  console.log('[Test2] result', result);
  for (const n of result.notes) {
    // eslint-disable-next-line no-console
    console.log('  ·', n);
  }
  return result;
}

if (typeof window !== 'undefined') {
  (window as any).__perfAuditTest2 = runTest2Console;
}
