/**
 * Production freeze pipeline for formula and link-formula columns.
 *
 * Two mechanisms, one function:
 *
 * - **Plain formula** (validated 2026-05-19, Test 3, 12.8s on 69k rows):
 *   add a snapshot column populated from SQL, then rewrite the formula's
 *   expression to `{snapshotName}`. The column stays type:'formula' and key
 *   is preserved.
 *
 * - **Link-formula** (validated 2026-05-20, Test 7, 35.3s on 69k rows):
 *   same snapshot column, plus a same-table "self-link" so every row links
 *   to itself, then mutate the LF's `data` so it evaluates as
 *   lookup-through-self-link → snapshot. Column stays type:'link-formula'.
 *
 * Both paths bypass the 60s nginx wall on `modify_column_type` and preserve
 * the column key — external references (forms, apps, automations) keep
 * working, they just read the static snapshot value.
 *
 * Auto-rollback on failure after the snapshot column is created: restore the
 * original `data` block via applyLocalOperation; DELETE helper columns we
 * created this call (never deletes a reused self-link).
 *
 * Differs from the Test 7 harness: no acknowledgeProduction gate, no
 * auto-restore, returns a flat `{ ok, error, ... }` result with helper
 * column keys + originalData (caller persists for unfreeze). For link-formula
 * candidates, detects an existing `_frozenLink_<tableName>` and reuses it
 * across multiple freezes on the same table.
 *
 * Parameterized on (dtableSDK, accessToken, dtableUuid, serverUrl) so the
 * same function applies to production or sandbox SDKs.
 *
 * See:
 * - [[reference_self_link_indirection_mechanism]] — the LF mechanism in detail.
 * - [[reference_apply_pipeline_endpoints]] — endpoint URL shapes.
 * - [[reference_dtable_sdk_modify_column_type_signature]] — the canEditMetadata
 *   bypass via applyLocalOperation we use for the swap step.
 */

import dayjs from 'dayjs';

// ----------------------------------------------------------------------------
// Shape types
// ----------------------------------------------------------------------------

export type ShapeMode = 'scalar' | 'collapsed-array' | 'multi-array';

/** SeaTable formula error sentinels (#VALUE!, #NAME?, #REF!, #DIV/0!, #N/A, ...).
 *  Same pattern as tableAuditor.ts. Returned by the SQL endpoint as scalar
 *  strings even when the formula's result_type is `array` — passing them through
 *  to batch_update_rows produces a 400. We coerce to null at collection time. */
const FORMULA_ERROR_PATTERN = /^#[A-Z!?]+/;

/** Element types we'll happily turn into a typed snapshot column. Other array_types
 *  (e.g. nested formula, link, etc.) stay as long-text. */
export const COLLAPSIBLE_ARRAY_ELEMENT_TYPES = new Set([
  'text',
  'long-text',
  'number',
  'date',
  'checkbox',
  'single-select',
  'multiple-select',
  'url',
  'email',
  'rate',
  'duration',
]);

export function snapshotTypeForResultType(resultType: string | undefined): string {
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
      return 'long-text';
    default:
      return 'text';
  }
}

/**
 * Serialize an LF cell value for storage in the long-text snapshot column.
 * Arrays of primitives become `separator`-joined strings. Arrays of objects
 * (linked-record refs etc.) JSON-stringify each element. Date arrays use
 * `arrayData.format` so the snapshot renders the same way the original LF did.
 */
export function serializeForSnapshot(
  value: any,
  separator: string,
  arrayType?: string,
  arrayData?: any
): any {
  if (value == null) return value;
  if (!Array.isArray(value)) return value;
  return value
    .map((v) => {
      if (v == null) return '';
      if (arrayType === 'date' && typeof v === 'string') {
        const fmt = arrayData?.format || 'YYYY-MM-DD';
        const parsed = dayjs(v);
        return parsed.isValid() ? parsed.format(fmt) : v;
      }
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    })
    .join(separator);
}

/**
 * Build the `column_data` payload for the snapshot column at creation time so
 * SeaTable renders values in the user's configured format.
 *
 * - scalar: snapshot mirrors a non-array LF; format lives on originalData top-level.
 * - collapsed-array: snapshot mirrors the element type of an array LF whose values
 *   are all length ≤ 1; format lives in originalData.array_data.
 * - multi-array: snapshot is long-text; no column_data (formatting handled by
 *   `serializeForSnapshot`).
 */
export function deriveSnapshotColumnData(
  originalData: any,
  snapshotType: string,
  shapeMode: ShapeMode
): Record<string, any> | undefined {
  if (shapeMode === 'multi-array') return undefined;
  const source = shapeMode === 'collapsed-array' ? originalData.array_data || {} : originalData;
  switch (snapshotType) {
    case 'number': {
      const d: Record<string, any> = {};
      if (source.format !== undefined) d.format = source.format;
      if (source.decimal !== undefined) d.decimal = source.decimal;
      if (source.thousands !== undefined) d.thousands = source.thousands;
      if (source.precision !== undefined) d.precision = source.precision;
      if (source.enable_precision !== undefined) d.enable_precision = source.enable_precision;
      if (source.currency_symbol !== undefined) d.currency_symbol = source.currency_symbol;
      return Object.keys(d).length ? d : undefined;
    }
    case 'date':
      return source.format ? { format: source.format } : undefined;
    case 'duration': {
      const d: Record<string, any> = {};
      if (source.format !== undefined) d.format = source.format;
      if (source.duration_format !== undefined) d.duration_format = source.duration_format;
      return Object.keys(d).length ? d : undefined;
    }
    case 'single-select':
    case 'multiple-select':
      return source.options ? { options: JSON.parse(JSON.stringify(source.options)) } : undefined;
    default:
      return undefined;
  }
}

// ----------------------------------------------------------------------------
// HTTP helpers (api-gateway endpoints). All return `{ok, ms, status, body?, ...}`.
// Tokens, uuid, serverUrl are passed explicitly so sandbox SDKs can drive these.
// ----------------------------------------------------------------------------

export async function fetchWithTimeout(
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

export async function httpAddColumn(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  body: Record<string, any>,
  timeoutMs: number
): Promise<{
  ok: boolean;
  ms: number;
  key?: string;
  linkId?: string;
  raw?: any;
  body?: string;
  status: number;
}> {
  const t0 = Date.now();
  const { resp, error } = await fetchWithTimeout(
    `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/columns/`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  const ms = Date.now() - t0;
  if (error) return { ok: false, ms, status: 0, body: error };
  if (!resp || !resp.ok) {
    const text = resp ? await resp.text().catch(() => '') : '';
    return { ok: false, ms, status: resp?.status ?? 0, body: text };
  }
  const data = await resp.json().catch(() => ({}));
  return {
    ok: true,
    ms,
    status: resp.status,
    key: data?.key,
    linkId: data?.data?.link_id,
    raw: data,
  };
}

export async function httpDeleteColumn(
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
    const text = resp ? await resp.text().catch(() => '') : '';
    return { ok: false, ms, status: resp?.status ?? 0, body: text };
  }
  return { ok: true, ms, status: resp.status };
}

export async function httpSqlChunk(
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
    const text = resp ? await resp.text().catch(() => '') : '';
    return { ok: false, ms, status: resp?.status ?? 0, rows: [], metadata: [], body: text };
  }
  const data = await resp.json().catch(() => ({}));
  const rows: any[] = data?.results || data?.rows || [];
  const metadata: any[] = data?.metadata || data?.columns || [];
  return { ok: true, ms, status: resp.status, rows, metadata };
}

export async function httpBatchUpdate(
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
    const text = resp ? await resp.text().catch(() => '') : '';
    return { ok: false, ms, status: resp?.status ?? 0, body: text };
  }
  return { ok: true, ms, status: resp.status };
}

/**
 * Replace link values for a batch of rows. Shape matches seatable-api-python's
 * `batch_update_links`: PUT /links/ with
 *   { link_id, table_name, other_table_name, row_id_list, other_rows_ids_map }.
 */
export async function httpBatchUpdateLinks(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  body: {
    link_id: string;
    table_name: string;
    other_table_name: string;
    row_id_list: string[];
    other_rows_ids_map: Record<string, string[]>;
  },
  timeoutMs: number
): Promise<{ ok: boolean; ms: number; body?: string; status: number }> {
  const t0 = Date.now();
  const { resp, error } = await fetchWithTimeout(
    `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/links/`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  const ms = Date.now() - t0;
  if (error) return { ok: false, ms, status: 0, body: error };
  if (!resp || !resp.ok) {
    const text = resp ? await resp.text().catch(() => '') : '';
    return { ok: false, ms, status: resp?.status ?? 0, body: text };
  }
  return { ok: true, ms, status: resp.status };
}

/**
 * PUT a view's hidden_columns. Replaces the array (does not merge) — caller
 * provides the full desired list. Used by `hideColumnInAllViews` to add a
 * freshly-created helper column key to each view's hidden set.
 */
export async function httpUpdateViewHidden(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  tableName: string,
  viewName: string,
  hiddenColumns: string[],
  timeoutMs: number
): Promise<{ ok: boolean; ms: number; body?: string; status: number }> {
  const t0 = Date.now();
  const { resp, error } = await fetchWithTimeout(
    `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/views/${encodeURIComponent(viewName)}/?table_name=${encodeURIComponent(tableName)}`,
    {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ hidden_columns: hiddenColumns }),
    },
    timeoutMs
  );
  const ms = Date.now() - t0;
  if (error) return { ok: false, ms, status: 0, body: error };
  if (!resp || !resp.ok) {
    const text = resp ? await resp.text().catch(() => '') : '';
    return { ok: false, ms, status: resp?.status ?? 0, body: text };
  }
  return { ok: true, ms, status: resp.status };
}

/**
 * Best-effort: append `columnKey` to the hidden_columns of every view of
 * `tableName`. Used to hide freshly-created helper columns (snapshot / self-link)
 * so they don't clutter the user's view of the table.
 *
 * Failures don't abort the freeze — the user just sees an extra column. We
 * log via the returned `failed` count + `firstError` for the caller.
 */
async function hideColumnInAllViews(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  tableName: string,
  views: any[],
  columnKey: string,
  timeoutMs: number
): Promise<{ hidden: number; failed: number; firstError?: string }> {
  let hidden = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (const view of views) {
    if (!view?.name) continue;
    const existing: string[] = view.hidden_columns || [];
    if (existing.includes(columnKey)) {
      hidden++;
      continue;
    }
    const merged = [...existing, columnKey];
    const res = await httpUpdateViewHidden(
      serverUrl,
      uuid,
      accessToken,
      tableName,
      view.name,
      merged,
      timeoutMs
    );
    if (res.ok) {
      hidden++;
    } else {
      failed++;
      if (!firstError) {
        firstError = `view "${view.name}": HTTP ${res.status} ${(res.body || '').slice(0, 100)}`;
      }
    }
  }
  return { hidden, failed, firstError };
}

// ----------------------------------------------------------------------------
// Resilience helpers — retry-on-5xx and server-health cooldown.
//
// Sequential freezes stack backend pressure: each adds columns, batch-writes
// many cells, and commits a WS modify_column_data op. Empirically, the second
// freeze in a row sometimes hits a transient 500 mid-pipeline because the
// backend hasn't settled. The two patterns below mitigate this:
//
//   - `withRetry5xx`: retries a 5xx-failing HTTP thunk with exponential
//     backoff. Used inside freezeColumnViaIndirection's heavy phases (SQL read,
//     batch update rows, batch update links). One transient 500 on chunk 30/70
//     no longer kills the entire freeze.
//
//   - `waitForServerSettled`: a mandatory cooldown + /metadata/ preflight
//     called by applyRemediationsToBase between sequential freezes. Gives the
//     backend time to drain queued work before the next pipeline starts.
//
// Both are intentionally simple. The helpers below (httpAddColumn, etc.) stay
// unwrapped so Test 7 still sees raw, non-retrying behavior — diagnostic
// harnesses want to see what fails.
// ----------------------------------------------------------------------------

async function withRetry5xx<R extends { ok: boolean; status: number; body?: string }>(
  fn: () => Promise<R>,
  opts?: {
    retries?: number;
    baseDelayMs?: number;
    onProgress?: (msg: string) => void;
    label?: string;
  }
): Promise<R> {
  const retries = opts?.retries ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;
  let last: R | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await fn();
    if (last.ok) return last;
    // Only retry on 5xx. 4xx is a client error — won't fix itself with a retry.
    if (last.status < 500 || last.status >= 600) return last;
    if (attempt === retries) return last;
    const delay = baseDelayMs * Math.pow(2, attempt); // 1s, 2s, 4s
    if (opts?.onProgress && opts?.label) {
      opts.onProgress(
        `${opts.label} — HTTP ${last.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${retries})...`
      );
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  return last as R;
}

/**
 * Pause + server-health preflight between freezes. The previous freeze's WS op
 * has just committed; the backend is still indexing helper columns and
 * cell-update I/O. Starting the next freeze immediately can land on a
 * still-saturated backend and 500 mid-pipeline.
 *
 * Strategy: mandatory 2s cooldown, then GET /metadata/ with a 5s budget. If
 * it responds fast (<1.5s), we proceed. Otherwise, wait longer and retry up
 * to 3 times. After 3 attempts we give up waiting and let the next op surface
 * the real problem if one persists — better to fail loudly than spin forever.
 */
export async function waitForServerSettled(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  if (onProgress) onProgress('Letting the backend settle...');
  await new Promise((r) => setTimeout(r, 2000));
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = Date.now();
    const { resp } = await fetchWithTimeout(
      `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/metadata/`,
      {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
        cache: 'no-store',
      },
      5000
    );
    const elapsed = Date.now() - t0;
    if (resp?.ok && elapsed < 1500) return;
    if (onProgress) {
      onProgress(
        `Backend still busy (${elapsed}ms, status ${resp?.status ?? 'no-response'}) — waiting...`
      );
    }
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
}

// ----------------------------------------------------------------------------
// freezeColumnViaIndirection — the production freeze function
// ----------------------------------------------------------------------------

export interface FreezeColumnOpts {
  /** Production or sandbox SDK. Must expose getTables() and dtableStore. */
  dtableSDK: any;
  tableName: string;
  /** Column to freeze. Must be type:'formula' or 'link-formula'. Plain formula
   * columns with array result_type are rejected for now. */
  columnName: string;
  /** Explicit auth — not pulled from SDK so sandbox can target a different base. */
  accessToken: string;
  dtableUuid: string;
  serverUrl: string;
  /** Override default `_frozen_<columnName>`. Must not already exist. */
  snapshotColumnName?: string;
  /** Override default `_frozenLink_<tableName>` (link-formula only). If a same-
   * table link column with this name already exists, it's reused (shared self-
   * link across freezes on this table). Unused for plain formula candidates. */
  selfLinkColumnName?: string;
  onProgress?: (msg: string) => void;
  sqlChunkSize?: number; // default 10_000 (SeaTable SQL cap)
  batchUpdateChunkSize?: number; // default 1_000 (batch_update_rows API limit)
  linksBatchChunkSize?: number; // default 1_000
  httpTimeoutMs?: number; // default 90s
  arraySeparator?: string; // default ', '
  /** When true, the snapshot / self-link columns are left visible in every
   * view of the parent table. Useful in sandbox apply paths so the user can
   * inspect what the freeze actually created. Default false — production
   * applies hide the helpers to keep tables tidy. */
  keepHelpersVisible?: boolean;
  /** Called when shape detection determines the column is multi-array (its
   *  rows hold arrays with >1 element OR an array_type we can't collapse).
   *  Freezing changes downstream consumers' shape from array to joined string,
   *  so the user needs to confirm. Resolve with `true` to proceed, `false` to
   *  abort the freeze cleanly (no mutations have run yet at this point). */
  confirmMultiArray?: (info: {
    tableName: string;
    columnName: string;
    rowCount: number;
    arrayType: string | undefined;
  }) => Promise<boolean>;
}

export interface FreezeColumnResult {
  ok: boolean;
  error?: string;
  /** Frozen column's key — unchanged from before the freeze. */
  lfColumnKey: string;
  /** Snapshot (a.k.a. donor) column key. Caller persists for unfreeze. */
  snapshotColumnKey: string;
  /** Self-link column key — empty for plain formula candidates. */
  selfLinkColumnKey: string;
  /** Self-link's link_id — empty for plain formula candidates. */
  selfLinkId: string;
  /** Original LF `data` block. Restore by applyLocalOperation on unfreeze. */
  originalData: any;
  /** Informs UI warnings (e.g. multi-array changes downstream consumers' shape). */
  shapeMode: ShapeMode;
  rowCount: number;
  /** True when the self-link was reused from a prior freeze on this table.
   *  Phase B unfreeze must refcount and only delete when no other LFs reference it. */
  selfLinkReused: boolean;
}

export async function freezeColumnViaIndirection(
  opts: FreezeColumnOpts
): Promise<FreezeColumnResult> {
  const {
    dtableSDK,
    tableName,
    columnName,
    accessToken,
    dtableUuid,
    serverUrl,
    onProgress,
    sqlChunkSize = 10_000,
    batchUpdateChunkSize = 1_000,
    linksBatchChunkSize = 1_000,
    httpTimeoutMs = 90 * 1000,
    arraySeparator = ', ',
  } = opts;

  const snapshotColumnName = opts.snapshotColumnName || `_frozen_${columnName}`;
  const selfLinkColumnName = opts.selfLinkColumnName || `_frozenLink_${tableName}`;

  const fail = (error: string, extra?: Partial<FreezeColumnResult>): FreezeColumnResult => ({
    ok: false,
    error,
    lfColumnKey: '',
    snapshotColumnKey: '',
    selfLinkColumnKey: '',
    selfLinkId: '',
    originalData: null,
    shapeMode: 'scalar',
    rowCount: 0,
    selfLinkReused: false,
    ...extra,
  });

  // ---- Pre-flight: locate table + target column.
  const tables: any[] = dtableSDK.getTables();
  const tableIndex = tables.findIndex((t: any) => t.name === tableName);
  if (tableIndex < 0) return fail(`table "${tableName}" not found`);
  const tbl = tables[tableIndex];
  const lfCol = (tbl.columns || []).find((c: any) => c.name === columnName);
  if (!lfCol) return fail(`column "${columnName}" not found in "${tableName}"`);
  const columnType: string = lfCol.type;
  if (columnType !== 'link-formula' && columnType !== 'formula') {
    return fail(`"${columnName}" is type "${columnType}", expected "link-formula" or "formula"`);
  }
  const isLinkFormula = columnType === 'link-formula';

  const lfColumnKey: string = lfCol.key;
  const originalData = JSON.parse(JSON.stringify(lfCol.data || {}));
  const resultType: string | undefined = originalData.result_type;
  const rowCount = (tbl.rows || []).length;
  const isArrayResult = resultType === 'array';

  // Plain formulas with array result types aren't supported yet — the
  // `{ColumnName}` reference syntax doesn't preserve array shape the same way
  // the link-formula's lookup-through-self-link path does.
  if (!isLinkFormula && isArrayResult) {
    return fail(
      `plain formula "${columnName}" returns an array (result_type=array, not yet supported)`,
      { lfColumnKey, originalData, rowCount }
    );
  }

  // Snapshot name collision check applies to both types.
  const existingCols = tbl.columns || [];
  const existingSnapshot = existingCols.find((c: any) => c.name === snapshotColumnName);
  if (existingSnapshot) {
    return fail(
      `snapshot column "${snapshotColumnName}" already exists. Choose a different name or delete the prior column.`,
      { lfColumnKey, originalData, rowCount }
    );
  }
  // Self-link detection only matters for link-formula columns.
  let reuseSelfLink: { key: string; linkId: string } | null = null;
  if (isLinkFormula) {
    const existingSelfLink = existingCols.find((c: any) => c.name === selfLinkColumnName);
    if (existingSelfLink) {
      if (
        existingSelfLink.type === 'link' &&
        existingSelfLink.data?.table === tableName &&
        existingSelfLink.data?.other_table === tableName &&
        existingSelfLink.data?.link_id
      ) {
        reuseSelfLink = {
          key: existingSelfLink.key,
          linkId: existingSelfLink.data.link_id,
        };
      } else {
        return fail(
          `column "${selfLinkColumnName}" exists but isn't a same-table link column. Choose a different selfLinkColumnName.`,
          { lfColumnKey, originalData, rowCount }
        );
      }
    }
  }

  let shapeMode: ShapeMode = isArrayResult ? 'multi-array' : 'scalar';
  let snapshotType = snapshotTypeForResultType(resultType);
  let snapshotColumnKey = '';
  let selfLinkColumnKey = reuseSelfLink?.key || '';
  let selfLinkId = reuseSelfLink?.linkId || '';
  let swapApplied = false;

  // Rollback helpers — call only after the corresponding phase succeeded.
  const restoreLfData = (): void => {
    try {
      const store = dtableSDK.dtableStore;
      const op = store.createOperation({
        type: 'modify_column_data',
        table_id: tbl._id,
        column_key: lfColumnKey,
        column_data: originalData,
      });
      store.applyLocalOperation(op);
    } catch {
      // best effort
    }
  };
  const deleteHelper = async (key: string): Promise<void> => {
    if (!key) return;
    await httpDeleteColumn(serverUrl, dtableUuid, accessToken, tableName, key, httpTimeoutMs);
  };
  const rollback = async (error: string): Promise<FreezeColumnResult> => {
    if (swapApplied) restoreLfData();
    // Only delete a self-link we created in this call — never a reused one.
    if (!reuseSelfLink) await deleteHelper(selfLinkColumnKey);
    await deleteHelper(snapshotColumnKey);
    return {
      ok: false,
      error,
      lfColumnKey,
      snapshotColumnKey: '',
      selfLinkColumnKey: '',
      selfLinkId: '',
      originalData,
      shapeMode,
      rowCount,
      selfLinkReused: !!reuseSelfLink,
    };
  };

  // ---- Phase 1: SQL-read LF values + row _ids. Detects array shape.
  if (onProgress) {
    onProgress(`Reading ${rowCount} values from ${tableName} › ${columnName}...`);
  }
  const collected: Map<string, any> = new Map();
  let formulaErrorRowCount = 0;
  for (let offset = 0; offset < rowCount; offset += sqlChunkSize) {
    if (onProgress) {
      onProgress(
        `Reading rows ${offset}–${Math.min(offset + sqlChunkSize, rowCount)} of ${rowCount}...`
      );
    }
    const chunk = await withRetry5xx(
      () =>
        httpSqlChunk(
          serverUrl,
          dtableUuid,
          accessToken,
          `SELECT _id, \`${columnName}\` FROM \`${tableName}\` LIMIT ${sqlChunkSize} OFFSET ${offset}`,
          httpTimeoutMs
        ),
      { onProgress, label: `SQL read offset ${offset}` }
    );
    if (!chunk.ok) {
      return fail(`SQL read failed: HTTP ${chunk.status}: ${(chunk.body || '').slice(0, 200)}`, {
        lfColumnKey,
        originalData,
        rowCount,
      });
    }
    const valKey =
      chunk.metadata.find((m: any) => (m.name || m.column_name) === columnName)?.key ||
      chunk.metadata.find((m: any) => (m.name || m.column_name) === columnName)?.column_key ||
      lfColumnKey;
    for (const r of chunk.rows) {
      const id = r._id || r._rowid;
      if (!id) continue;
      const raw = r[valKey];
      if (typeof raw === 'string' && FORMULA_ERROR_PATTERN.test(raw)) {
        formulaErrorRowCount += 1;
        collected.set(id, null);
      } else {
        collected.set(id, raw);
      }
    }
    if (chunk.rows.length < sqlChunkSize) break;
  }

  if (formulaErrorRowCount > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[freezeColumn] ${tableName} › ${columnName}: ${formulaErrorRowCount} row(s) had formula errors (#VALUE! etc) — frozen as empty.`
    );
  }

  // Shape inspection: a result_type:'array' LF whose every row has length ≤ 1 AND
  // whose array_type is a "simple" type can use a typed snapshot, preserving
  // color rules / date filters / select semantics.
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
    } else {
      shapeMode = 'multi-array';
      snapshotType = 'long-text';
    }
  }

  // ---- Multi-array confirmation gate.
  // Freezing a multi-array column changes its observable shape — what was
  // `[a, b, c]` becomes `[\"a, b, c\"]` (long-text-array of length 1). Forms,
  // automations, integrations reading this column will see a string instead
  // of a multi-element array. We do this check AFTER Phase 1 (SQL read) but
  // BEFORE any mutation, so we can bail cleanly with no rollback needed.
  if (shapeMode === 'multi-array' && opts.confirmMultiArray) {
    const confirmed = await opts.confirmMultiArray({
      tableName,
      columnName,
      rowCount: collected.size,
      arrayType: originalData.array_type,
    });
    if (!confirmed) {
      return fail('User cancelled — multi-array shape change not confirmed', {
        lfColumnKey,
        originalData,
        rowCount,
        shapeMode,
      });
    }
  }

  // ---- Phase 2: Add snapshot column.
  if (onProgress) {
    onProgress(`Adding snapshot column "${snapshotColumnName}" (${snapshotType})...`);
  }
  const snapshotColumnData = deriveSnapshotColumnData(originalData, snapshotType, shapeMode);
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
  if (!addSnap.ok) {
    return fail(
      `Add snapshot column failed: HTTP ${addSnap.status}: ${(addSnap.body || '').slice(0, 200)}`,
      { lfColumnKey, originalData, rowCount, shapeMode }
    );
  }
  snapshotColumnKey =
    addSnap.key ||
    (await resolveColumnKey(
      serverUrl,
      dtableUuid,
      accessToken,
      tableName,
      snapshotColumnName,
      httpTimeoutMs
    ));
  if (!snapshotColumnKey) {
    return rollback('snapshot column key unresolved after create');
  }

  // Hide the snapshot column in all views immediately, before populate, so the
  // user never sees it appear in the UI. Best-effort: a failure here just means
  // the column is visible; the freeze itself still works. Skipped entirely for
  // sandbox applies (keepHelpersVisible: true) — there the user is reviewing
  // what the freeze creates and benefits from seeing the helpers explicitly.
  if (!opts.keepHelpersVisible) {
    if (onProgress) onProgress('Hiding snapshot column in all views...');
    const hideSnap = await hideColumnInAllViews(
      serverUrl,
      dtableUuid,
      accessToken,
      tableName,
      tbl.views || [],
      snapshotColumnKey,
      httpTimeoutMs
    );
    if (hideSnap.failed > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[freezeColumn] snapshot column visible in ${hideSnap.failed} view(s) — ${hideSnap.firstError || 'unknown'}`
      );
    }
  }

  // ---- Phase 3: Populate snapshot via batch_update_rows.
  if (onProgress) onProgress('Populating snapshot column...');
  const allUpdates = Array.from(collected.entries()).map(([row_id, value]) => {
    let serialized: any;
    if (shapeMode === 'scalar') {
      serialized = value;
    } else if (shapeMode === 'collapsed-array') {
      serialized = Array.isArray(value) ? (value.length > 0 ? value[0] : null) : value;
    } else {
      serialized = serializeForSnapshot(
        value,
        arraySeparator,
        originalData.array_type,
        originalData.array_data
      );
    }
    return { row_id, row: { [snapshotColumnName]: serialized } };
  });
  for (let i = 0; i < allUpdates.length; i += batchUpdateChunkSize) {
    if (onProgress) {
      onProgress(
        `Populating snapshot: ${i}/${allUpdates.length} (${Math.round((i / Math.max(1, allUpdates.length)) * 100)}%)...`
      );
    }
    const slice = allUpdates.slice(i, i + batchUpdateChunkSize);
    const res = await withRetry5xx(
      () => httpBatchUpdate(serverUrl, dtableUuid, accessToken, tableName, slice, httpTimeoutMs),
      { onProgress, label: `Populate snapshot chunk ${i / batchUpdateChunkSize + 1}` }
    );
    if (!res.ok) {
      return rollback(
        `Populate snapshot failed: HTTP ${res.status}: ${(res.body || '').slice(0, 200)}`
      );
    }
  }

  // ---- Phase 4-5: Self-link add + populate. Link-formula only.
  // Plain formula columns reference the snapshot directly via `{snapshotName}`
  // formula syntax — no self-link needed.
  if (isLinkFormula) {
    // ---- Phase 4: Add self-link column (skipped on reuse).
    if (!reuseSelfLink) {
      if (onProgress) onProgress(`Adding self-link column "${selfLinkColumnName}"...`);
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
      if (addLink.ok) {
        selfLinkColumnKey = addLink.key || '';
        selfLinkId = addLink.linkId || '';
        if (!selfLinkColumnKey || !selfLinkId) {
          const resolved = await resolveSelfLinkMetadata(
            serverUrl,
            dtableUuid,
            accessToken,
            tableName,
            selfLinkColumnName,
            httpTimeoutMs
          );
          selfLinkColumnKey = selfLinkColumnKey || resolved.key;
          selfLinkId = selfLinkId || resolved.linkId;
        }
        if (!selfLinkColumnKey || !selfLinkId) {
          return rollback('self-link key/link_id unresolved after create');
        }
        // Hide self-link in all views immediately. Best-effort like the snapshot
        // hide. Reused self-links skip this — they were hidden on the prior freeze.
        // Skipped entirely for sandbox applies (keepHelpersVisible: true).
        if (!opts.keepHelpersVisible) {
          if (onProgress) onProgress('Hiding self-link column in all views...');
          const hideLink = await hideColumnInAllViews(
            serverUrl,
            dtableUuid,
            accessToken,
            tableName,
            tbl.views || [],
            selfLinkColumnKey,
            httpTimeoutMs
          );
          if (hideLink.failed > 0) {
            // eslint-disable-next-line no-console
            console.warn(
              `[freezeColumn] self-link column visible in ${hideLink.failed} view(s) — ${hideLink.firstError || 'unknown'}`
            );
          }
        }
      } else {
        // Add-self-link 4xx'd. Most likely cause in a multi-freeze batch: a
        // prior freeze already created `_frozenLink_<tableName>` but the SDK
        // websocket lag meant the reuse check at the top of this function
        // (line ~673) didn't see it yet — so we ended up here on the create
        // path. Hit /metadata/ directly to confirm; if we find a valid
        // same-table link column, treat it as a reused self-link.
        if (onProgress) {
          onProgress(
            `Add self-link returned HTTP ${addLink.status} — checking /metadata/ for pre-existing column...`
          );
        }
        const fallback = await findValidSelfLinkInMetadata(
          serverUrl,
          dtableUuid,
          accessToken,
          tableName,
          selfLinkColumnName,
          httpTimeoutMs
        );
        if (!fallback) {
          return rollback(
            `Add self-link failed: HTTP ${addLink.status}: ${(addLink.body || '').slice(0, 200)}`
          );
        }
        reuseSelfLink = fallback;
        selfLinkColumnKey = fallback.key;
        selfLinkId = fallback.linkId;
        if (onProgress) {
          onProgress(`Reusing existing self-link "${selfLinkColumnName}" (resolved via /metadata/)`);
        }
        // Hide is skipped in this branch for the same reason as the normal
        // reuse path: a prior freeze hid the column already. (If the column
        // was created out-of-band and is visible, the user accepts the
        // cosmetic noise — same trade as the SDK-cache reuse path.)
      }
    }

    // ---- Phase 5: Populate self-link (every row → itself). Always runs, even on
    // reuse — covers rows added since a prior freeze. PUT /links/ replaces, so it's
    // idempotent.
    if (onProgress) onProgress(`Populating self-link (${collected.size} rows)...`);
    const allRowIds = Array.from(collected.keys());
    for (let i = 0; i < allRowIds.length; i += linksBatchChunkSize) {
      if (onProgress) {
        onProgress(
          `Populating self-link: ${i}/${allRowIds.length} (${Math.round((i / Math.max(1, allRowIds.length)) * 100)}%)...`
        );
      }
      const slice = allRowIds.slice(i, i + linksBatchChunkSize);
      const map: Record<string, string[]> = {};
      for (const id of slice) map[id] = [id];
      const res = await withRetry5xx(
        () =>
          httpBatchUpdateLinks(
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
          ),
        { onProgress, label: `Populate self-link chunk ${i / linksBatchChunkSize + 1}` }
      );
      if (!res.ok) {
        return rollback(
          `Populate self-link failed: HTTP ${res.status}: ${(res.body || '').slice(0, 200)}`
        );
      }
    }
  }

  // ---- Phase 6: Mutate column data via applyLocalOperation. NOT setColumnData —
  // the canEditMetadata gate silently no-ops setColumnData on columns with
  // edit_metadata_permission_type set when window.dtable.isAdmin isn't true.
  let mutatedData: any;
  let expectedFormula: string;
  if (isLinkFormula) {
    if (onProgress) onProgress('Swapping LF formula to lookup-through-self-link...');
    expectedFormula = 'lookup';
    mutatedData = {
      formula: 'lookup',
      link_column_key: selfLinkColumnKey,
      column_key_in_linked_record: snapshotColumnKey,
      level1_linked_table_column_key: snapshotColumnKey,
      result_type: resultType,
      operated_columns: [selfLinkColumnKey, snapshotColumnKey],
    };
    if (isArrayResult) {
      mutatedData.array_type =
        shapeMode === 'collapsed-array' ? originalData.array_type : 'long-text';
      if (shapeMode === 'collapsed-array' && originalData.array_data) {
        mutatedData.array_data = JSON.parse(JSON.stringify(originalData.array_data));
      }
    }
    if (shapeMode === 'scalar') {
      if (originalData.format) mutatedData.format = originalData.format;
      if (originalData.decimal !== undefined) mutatedData.decimal = originalData.decimal;
      if (originalData.thousands !== undefined) mutatedData.thousands = originalData.thousands;
    }
  } else {
    // Plain formula: rewrite the expression to reference the snapshot column
    // directly. SeaTable formula syntax uses `{ColumnName}`, not column keys.
    if (onProgress) onProgress(`Swapping formula expression to {${snapshotColumnName}}...`);
    expectedFormula = `{${snapshotColumnName}}`;
    mutatedData = {
      ...originalData,
      formula: expectedFormula,
      operated_columns: [snapshotColumnKey],
    };
  }
  try {
    const store = dtableSDK.dtableStore;
    const op = store.createOperation({
      type: 'modify_column_data',
      table_id: tbl._id,
      column_key: lfColumnKey,
      column_data: mutatedData,
    });
    store.applyLocalOperation(op);
    const after = (dtableSDK.getTables()?.[tableIndex]?.columns || []).find(
      (c: any) => c.key === lfColumnKey
    );
    if (after?.data?.formula !== expectedFormula) {
      return rollback(`Swap rejected by SDK (formula=${JSON.stringify(after?.data?.formula)})`);
    }
    if (isLinkFormula && after?.data?.link_column_key !== selfLinkColumnKey) {
      return rollback(
        `Swap rejected by SDK (link_column_key=${JSON.stringify(after?.data?.link_column_key)})`
      );
    }
    swapApplied = true;
  } catch (e: any) {
    return rollback(`Swap threw: ${e?.message || e}`);
  }

  // ---- Phase 7: Verify by SQL sample (10 rows). Catches a successful swap
  // that produces wrong values (e.g. self-link not populated for some rows).
  if (onProgress) onProgress('Verifying...');
  const verify = await withRetry5xx(
    () =>
      httpSqlChunk(
        serverUrl,
        dtableUuid,
        accessToken,
        `SELECT \`${columnName}\`, \`${snapshotColumnName}\` FROM \`${tableName}\` LIMIT 10`,
        httpTimeoutMs
      ),
    { onProgress, label: 'Verify SQL' }
  );
  if (!verify.ok) {
    return rollback(
      `Verify SQL failed: HTTP ${verify.status}: ${(verify.body || '').slice(0, 200)}`
    );
  }
  const fKey =
    verify.metadata.find((m: any) => (m.name || m.column_name) === columnName)?.key ||
    verify.metadata.find((m: any) => (m.name || m.column_name) === columnName)?.column_key ||
    lfColumnKey;
  const sKey =
    verify.metadata.find((m: any) => (m.name || m.column_name) === snapshotColumnName)?.key ||
    verify.metadata.find((m: any) => (m.name || m.column_name) === snapshotColumnName)
      ?.column_key ||
    snapshotColumnKey;
  let matched = 0;
  let sampled = 0;
  for (const r of verify.rows) {
    const f = r[fKey];
    const s = r[sKey];
    if (f === undefined && s === undefined) continue;
    sampled++;
    if (f === s) matched++;
    else if (Array.isArray(f) && f.length === 1 && f[0] === s) matched++;
    else if (String(f ?? '') === String(s ?? '')) matched++;
  }
  if (sampled > 0 && matched !== sampled) {
    return rollback(`Verify mismatch: ${matched}/${sampled} sampled rows matched snapshot`);
  }

  return {
    ok: true,
    lfColumnKey,
    snapshotColumnKey,
    selfLinkColumnKey,
    selfLinkId,
    originalData,
    shapeMode,
    rowCount,
    selfLinkReused: !!reuseSelfLink,
  };
}

// ----------------------------------------------------------------------------
// Metadata resolvers — used when /columns/ POST returns a sparse response.
// ----------------------------------------------------------------------------

async function resolveColumnKey(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  tableName: string,
  columnName: string,
  timeoutMs: number
): Promise<string> {
  const meta = await httpSqlChunk(
    serverUrl,
    uuid,
    accessToken,
    `SELECT _id FROM \`${tableName}\` LIMIT 0`,
    timeoutMs
  );
  const col = meta.metadata?.find((m: any) => (m.name || m.column_name) === columnName);
  return col?.key || col?.column_key || '';
}

async function resolveSelfLinkMetadata(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  tableName: string,
  selfLinkColumnName: string,
  timeoutMs: number
): Promise<{ key: string; linkId: string }> {
  const metaResp = await fetchWithTimeout(
    `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/metadata/`,
    {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    },
    timeoutMs
  );
  if (!metaResp.resp?.ok) return { key: '', linkId: '' };
  const m = await metaResp.resp.json().catch(() => ({}));
  const t = (m?.metadata?.tables || []).find((x: any) => x.name === tableName);
  const c = t?.columns?.find((x: any) => x.name === selfLinkColumnName);
  return { key: c?.key || '', linkId: c?.data?.link_id || '' };
}

/**
 * Fallback for the create-self-link path: if `httpAddColumn` 4xx's (typically
 * a name-collision because a prior freeze in this batch created the self-link
 * but the SDK websocket lag meant our reuse check at line ~673 didn't see it
 * yet), check live `/metadata/` for an existing column with this name and
 * validate that it's a same-table link with a `link_id`. Returns reuse info
 * iff the existing column passes all validation; null otherwise (so the
 * caller can fail loudly on genuine collisions like a non-link column with
 * the same name).
 */
async function findValidSelfLinkInMetadata(
  serverUrl: string,
  uuid: string,
  accessToken: string,
  tableName: string,
  selfLinkColumnName: string,
  timeoutMs: number
): Promise<{ key: string; linkId: string } | null> {
  const metaResp = await fetchWithTimeout(
    `${serverUrl}/api-gateway/api/v2/dtables/${uuid}/metadata/`,
    {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    },
    timeoutMs
  );
  if (!metaResp.resp?.ok) return null;
  const m = await metaResp.resp.json().catch(() => ({}));
  const t = (m?.metadata?.tables || []).find((x: any) => x.name === tableName);
  const c = t?.columns?.find((x: any) => x.name === selfLinkColumnName);
  if (
    c?.type === 'link' &&
    c?.data?.table === tableName &&
    c?.data?.other_table === tableName &&
    c?.data?.link_id &&
    c?.key
  ) {
    return { key: c.key, linkId: c.data.link_id };
  }
  return null;
}

// ----------------------------------------------------------------------------
// unfreezeColumnViaIndirection — the inverse of freezeColumnViaIndirection.
// ----------------------------------------------------------------------------

export interface UnfreezeColumnOpts {
  dtableSDK: any;
  /** Frozen column's record (from plugin settings). Carries originalData,
   *  helper column keys, and identifiers. */
  tableName: string;
  columnKey: string;
  originalData: any;
  snapshotColumnKey: string;
  selfLinkColumnKey: string;
  /** Caller computes refcount across all frozen records and decides whether
   *  this is the last freeze using this self-link. When true, the self-link
   *  column is deleted; when false, it's left in place for other frozen LFs. */
  deleteSelfLink: boolean;
  accessToken: string;
  dtableUuid: string;
  serverUrl: string;
  onProgress?: (msg: string) => void;
  httpTimeoutMs?: number;
}

export interface UnfreezeColumnResult {
  ok: boolean;
  error?: string;
  /** True when the original formula data has been restored via applyLocalOperation.
   *  Helper-column cleanup is best-effort — if it fails, ok stays true and the
   *  caller may still clear the settings entry (column is no longer frozen). */
  restored: boolean;
  /** True if the snapshot column was deleted (or didn't exist). */
  snapshotDeleted: boolean;
  /** True if self-link was deleted (or skipped due to refcount, or didn't exist). */
  selfLinkDeleted: boolean;
}

export async function unfreezeColumnViaIndirection(
  opts: UnfreezeColumnOpts
): Promise<UnfreezeColumnResult> {
  const {
    dtableSDK,
    tableName,
    columnKey,
    originalData,
    snapshotColumnKey,
    selfLinkColumnKey,
    deleteSelfLink,
    accessToken,
    dtableUuid,
    serverUrl,
    onProgress,
    httpTimeoutMs = 90 * 1000,
  } = opts;

  // ---- Restore original `data` via applyLocalOperation.
  // setColumnData would silently no-op on columns with edit_metadata_permission_type
  // set when window.dtable.isAdmin isn't true (canEditMetadata gate). The op-channel
  // path bypasses that gate; server enforces real permissions independently.
  if (onProgress) onProgress(`Restoring ${tableName} › original formula...`);
  const tables: any[] = dtableSDK.getTables();
  const tableIndex = tables.findIndex((t: any) => t.name === tableName);
  if (tableIndex < 0) {
    return {
      ok: false,
      error: `table "${tableName}" not found`,
      restored: false,
      snapshotDeleted: false,
      selfLinkDeleted: false,
    };
  }
  const tbl = tables[tableIndex];
  const targetCol = (tbl.columns || []).find((c: any) => c.key === columnKey);
  if (!targetCol) {
    // Column was manually deleted from the base — nothing to restore. The caller
    // should still clear the settings entry. We delete the helpers below.
    return {
      ok: false,
      error: `column key "${columnKey}" not found in "${tableName}" (manually deleted?)`,
      restored: false,
      snapshotDeleted: false,
      selfLinkDeleted: false,
    };
  }
  let restored = false;
  try {
    const store = dtableSDK.dtableStore;
    const op = store.createOperation({
      type: 'modify_column_data',
      table_id: tbl._id,
      column_key: columnKey,
      column_data: originalData,
    });
    store.applyLocalOperation(op);
    restored = true;
  } catch (e: any) {
    return {
      ok: false,
      error: `restore failed: ${e?.message || e}`,
      restored: false,
      snapshotDeleted: false,
      selfLinkDeleted: false,
    };
  }

  // ---- Best-effort helper cleanup. Failures here log warnings but don't flip
  // ok to false — the column itself is unfrozen now, and the caller will clear
  // the settings entry on `ok: true`.
  let snapshotDeleted = false;
  let selfLinkDeleted = false;
  const warnings: string[] = [];

  if (snapshotColumnKey) {
    if (onProgress) onProgress('Deleting snapshot column...');
    const del = await httpDeleteColumn(
      serverUrl,
      dtableUuid,
      accessToken,
      tableName,
      snapshotColumnKey,
      httpTimeoutMs
    );
    if (del.ok || del.status === 404) {
      snapshotDeleted = true;
    } else {
      warnings.push(`snapshot delete HTTP ${del.status}: ${(del.body || '').slice(0, 100)}`);
    }
  } else {
    snapshotDeleted = true;
  }

  if (selfLinkColumnKey && deleteSelfLink) {
    if (onProgress) onProgress('Deleting self-link column...');
    const del = await httpDeleteColumn(
      serverUrl,
      dtableUuid,
      accessToken,
      tableName,
      selfLinkColumnKey,
      httpTimeoutMs
    );
    if (del.ok || del.status === 404) {
      selfLinkDeleted = true;
    } else {
      warnings.push(`self-link delete HTTP ${del.status}: ${(del.body || '').slice(0, 100)}`);
    }
  } else {
    // Either no self-link (plain-formula path) or refcount says other frozen
    // columns still need it — treat as success for the per-column unfreeze.
    selfLinkDeleted = true;
  }

  if (warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[unfreezeColumn] helper cleanup warnings:', warnings);
  }

  return {
    ok: true,
    restored,
    snapshotDeleted,
    selfLinkDeleted,
  };
}
