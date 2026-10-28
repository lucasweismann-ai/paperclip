/**
 * Usage and cost accounting for the Hermes local adapter, read from Hermes'
 * own ledger instead of its stdout.
 *
 * Hermes keeps authoritative per-session, per-model accounting in
 * `~/.hermes/state.db` (`session_model_usage`). It is written by the same code
 * that renders the CLI's own cost footer, and it carries a `cost_status` saying
 * whether a row is a reconciled `actual`, an `estimated`, `included` in a
 * subscription, or unpriced.
 *
 * Reading it replaces two regexes that scraped the child's stdout. Those
 * regexes matched no line Hermes actually prints -- it prints
 * `Input tokens: 1,868,210`, while the pattern required `tokens: N input` with
 * no thousands separators -- so every run recorded zero tokens. Worse, the cost
 * pattern `(?:cost|spent)[:\s]*\$?([\d.]+)` matched the *agent's own prose*, so
 * a sentence like "hosting cost: 0.07 per hour" became $0.07 of billed spend
 * while the real cost line (`**Cost:** ~$1.93 estimated`) did not match at all.
 * A seat could therefore set its own billed spend by typing the word "cost".
 *
 * Two invariants here are deliberate:
 *
 * - A session's rows accumulate across resumes, so a run is charged the
 *   *delta* against a baseline taken before the child starts.
 * - When the ledger has usage it could not price, tokens are reported with no
 *   cost at all rather than a cost of zero, so Paperclip records the row as
 *   `unpriced` instead of as a run that was free.
 */

import { createRequire } from "node:module";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

/** `cost_status` values that mean the row carries a usable price. */
const PRICED_COST_STATUS = new Set(["actual", "estimated", "included"]);

/** How long to wait for Hermes to flush accounting after the child exits. */
const SETTLE_ATTEMPTS = 6;
const SETTLE_INTERVAL_MS = 250;

/** Totals for one session, summed across every model it used. */
export interface LedgerTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiCalls: number;
  /** Sum of priced rows only. Unpriced rows contribute no cost. */
  costUsd: number;
  pricedRows: number;
  unpricedRows: number;
  /** Models whose rows recorded tokens but no usable price. */
  unpricedModels: string[];
}

/** What a single run consumed: the delta between two ledger reads. */
export interface LedgerDelta {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiCalls: number;
  costUsd: number;
  /** True when at least one row carried a usable price. */
  priced: boolean;
  /** True when at least one row recorded tokens with no usable price. */
  unpriced: boolean;
  unpricedModels: string[];
}

interface UsageRow {
  model?: unknown;
  api_call_count?: unknown;
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_tokens?: unknown;
  cache_write_tokens?: unknown;
  estimated_cost_usd?: unknown;
  actual_cost_usd?: unknown;
  cost_status?: unknown;
}

/** Resolve Hermes' state database: explicit config, then HERMES_HOME, then ~/.hermes. */
export function resolveStateDbPath(
  config: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> | undefined,
): string {
  const explicit = config?.hermesStateDb;
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  const home = env?.HERMES_HOME?.trim() || path.join(os.homedir(), ".hermes");
  return path.join(home, "state.db");
}

/** Non-negative integer counter, or 0. Providers occasionally report nonsense. */
function counter(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The usable cost of a row, or null when it has none.
 *
 * `actual_cost_usd` is NOT NULL DEFAULT 0, so 0 means "not yet reconciled"
 * rather than "free", and the estimate is used instead. A negative amount is
 * never a cost: OpenRouter publishes `prompt: -1, completion: -1` as sentinel
 * pricing for its router pseudo-models, which Hermes multiplied out into large
 * negative costs. Refusing it here keeps it out of any seat total.
 */
function rowCostUsd(actual: unknown, estimated: unknown): number | null {
  const reconciled = Number(actual);
  if (Number.isFinite(reconciled) && reconciled > 0) return reconciled;
  const estimate = Number(estimated);
  if (!Number.isFinite(estimate) || estimate < 0) return null;
  return estimate;
}

/** Only the slice of `node:sqlite` this module uses. */
interface ReadOnlyDatabase {
  prepare(sql: string): { all(...params: unknown[]): UsageRow[] };
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => ReadOnlyDatabase;
}

let sqliteModule: SqliteModule | null = null;
let sqliteLoadAttempted = false;

/** `node:sqlite` is built in from Node 22.5, but load defensively and once. */
function loadSqlite(): SqliteModule | null {
  if (!sqliteLoadAttempted) {
    sqliteLoadAttempted = true;
    try {
      sqliteModule = require("node:sqlite") as SqliteModule;
    } catch {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

/**
 * Session totals from Hermes' ledger, or null when they cannot be read.
 *
 * Null means "unknown" and is never substituted with zeros: a run whose usage
 * is unknown must not be recorded as a run that used nothing.
 */
export function readLedgerTotals(
  sessionId: string | null | undefined,
  dbPath: string | null | undefined,
): LedgerTotals | null {
  if (!sessionId || !dbPath || !fsSync.existsSync(dbPath)) return null;
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  let db: ReadOnlyDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT model, api_call_count, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens,
                estimated_cost_usd, actual_cost_usd, cost_status
           FROM session_model_usage
          WHERE session_id = ?`,
      )
      .all(sessionId);
    if (rows.length === 0) return null;

    const totals: LedgerTotals = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      apiCalls: 0,
      costUsd: 0,
      pricedRows: 0,
      unpricedRows: 0,
      unpricedModels: [],
    };

    for (const row of rows) {
      const input = counter(row.input_tokens);
      const cached = counter(row.cache_read_tokens) + counter(row.cache_write_tokens);
      const output = counter(row.output_tokens);
      totals.inputTokens += input;
      totals.cachedInputTokens += cached;
      totals.outputTokens += output;
      totals.apiCalls += counter(row.api_call_count);

      const cost = rowCostUsd(row.actual_cost_usd, row.estimated_cost_usd);
      if (cost !== null && PRICED_COST_STATUS.has(String(row.cost_status ?? ""))) {
        totals.costUsd += cost;
        totals.pricedRows += 1;
      } else if (input || cached || output) {
        totals.unpricedRows += 1;
        totals.unpricedModels.push(String(row.model ?? "unknown"));
      }
    }

    return totals;
  } catch {
    // A locked, truncated or schema-changed database is "unknown", not zero.
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed, or never opened.
    }
  }
}

/**
 * What this run consumed, given ledger reads from before and after it.
 *
 * Hermes resumes sessions and its rows accumulate, so the difference -- not the
 * total -- is what the run should be charged. Deltas are clamped at zero: the
 * ledger only grows, and a negative delta would mean the baseline was wrong.
 */
export function diffLedgerTotals(
  before: LedgerTotals | null,
  after: LedgerTotals | null,
): LedgerDelta | null {
  if (!after) return null;
  const base = before ?? {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    apiCalls: 0,
    costUsd: 0,
  };
  const grew = (now: unknown, was: unknown) => Math.max(0, counter(now) - counter(was));
  return {
    inputTokens: grew(after.inputTokens, base.inputTokens),
    cachedInputTokens: grew(after.cachedInputTokens, base.cachedInputTokens),
    outputTokens: grew(after.outputTokens, base.outputTokens),
    apiCalls: grew(after.apiCalls, base.apiCalls),
    // Costs are fractions of a cent, so round rather than floor.
    costUsd: Math.max(0, Math.round((after.costUsd - base.costUsd) * 1e6) / 1e6),
    priced: after.pricedRows > 0,
    unpriced: after.unpricedRows > 0,
    unpricedModels: [...new Set(after.unpricedModels)],
  };
}

/**
 * Read the ledger, giving Hermes a moment to flush its accounting.
 *
 * Hermes writes usage when it finalizes a session, which can land just after
 * the child exits. Polling until the totals move past the baseline avoids
 * charging a run zero because the read was a few milliseconds early.
 */
export async function readLedgerTotalsSettled(
  sessionId: string | null | undefined,
  dbPath: string | null | undefined,
  baseline: LedgerTotals | null,
): Promise<LedgerTotals | null> {
  let latest: LedgerTotals | null = null;
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    latest = readLedgerTotals(sessionId, dbPath);
    const moved =
      latest !== null &&
      (baseline === null ||
        latest.apiCalls > baseline.apiCalls ||
        latest.inputTokens > baseline.inputTokens ||
        latest.outputTokens > baseline.outputTokens);
    if (moved) return latest;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_INTERVAL_MS));
  }
  return latest;
}
