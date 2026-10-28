import { sql, type SQL } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "resultJson" | "executionStage">;

export const LEGACY_EXECUTION_SETTLEMENT_KEY = "legacyExecutionSettlement";
export const LEGACY_EXECUTION_SETTLEMENT_SCHEMA = "paperclip.legacy-execution-settlement.v1";

/** A cancelled legacy run's settlement receipt: the executor that owned the run
 * finished its own cleanup. This used to be recorded by overwriting
 * `execution_stage` with `settled`, which destroyed the only durable record of
 * how far the run got. The dispatch claim (`dispatching`) is committed before
 * adapter bootstrap, so it precedes every run event and the PID write; erasing
 * it left a terminal row unable to answer whether it ever reached dispatch, and
 * made two gates that read `preparing` unsatisfiable by construction.
 *
 * Settlement and progress are separate facts, so they now live in separate
 * fields. `stage` preserves what the stage held when cleanup ran. */
export type LegacyExecutionSettlement = {
  settledAt: string;
  controllerBootId: string | null;
  stage: string | null;
};

/** Written in the same statement that releases the controller lease, so a
 * settled row can never be observed still holding its lease. Re-running the
 * statement rewrites an equivalent receipt; it never consumes the stage. */
export function legacyExecutionSettlementReceipt(settledAt: Date, controllerBootId: string): SQL {
  return sql`case when ${heartbeatRuns.status} = 'cancelled'
    then coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || jsonb_build_object(
      ${LEGACY_EXECUTION_SETTLEMENT_KEY}::text, jsonb_build_object(
        'schema', ${LEGACY_EXECUTION_SETTLEMENT_SCHEMA}::text,
        'settledAt', ${settledAt.toISOString()}::text,
        'controllerBootId', ${controllerBootId}::text,
        'stage', ${heartbeatRuns.executionStage}))
    else ${heartbeatRuns.resultJson} end`;
}

export function readLegacyExecutionSettlement(run: Run): LegacyExecutionSettlement | null {
  const receipt = run.resultJson?.[LEGACY_EXECUTION_SETTLEMENT_KEY] as Record<string, unknown> | undefined;
  if (receipt?.schema !== LEGACY_EXECUTION_SETTLEMENT_SCHEMA || typeof receipt.settledAt !== "string") return null;
  return {
    settledAt: receipt.settledAt,
    controllerBootId: typeof receipt.controllerBootId === "string" ? receipt.controllerBootId : null,
    stage: typeof receipt.stage === "string" ? receipt.stage : null,
  };
}

/** Rows written before the receipt existed carry their settlement in
 * `execution_stage`, which is exactly why they can no longer report a stage.
 * Both forms certify the same executor-owned cleanup, so accepting both keeps
 * admission unchanged for every row already in the database. */
export function hasLegacyExecutionSettlement(run: Run): boolean {
  return Boolean(readLegacyExecutionSettlement(run)) || run.executionStage === "settled";
}

/** Did this run commit its dispatch claim? `null` means the answer was erased
 * by a build that overwrote the stage with its settlement, so a caller that
 * needs certainty must fall back to run events. */
export function reachedProviderDispatchStage(run: Run): boolean | null {
  const settlement = readLegacyExecutionSettlement(run);
  const stage = settlement ? settlement.stage : run.executionStage;
  if (stage === "settled") return null;
  return stage === "dispatching";
}
