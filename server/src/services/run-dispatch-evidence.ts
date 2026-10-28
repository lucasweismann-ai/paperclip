import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">;

export const LEGACY_ADAPTER_ENTERED = "legacy.adapter_entered";

export const PROVIDER_DISPATCH_EVENT_TYPES = [
  "adapter.invoke", LEGACY_ADAPTER_ENTERED, PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED,
  "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
  "provider.event", "provider.rpc_result", "tool.execution.started",
];

export async function hasProviderDispatchEvidence(db: Db, run: Run): Promise<boolean> {
  const [execution] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    or(isNotNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, PROVIDER_DISPATCH_EVENT_TYPES)),
  )).limit(1);
  return Boolean(execution);
}

export function readRunEnvironmentLeases(db: Db, run: Run) {
  return db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
}

export function leaseRetainsResources(lease: typeof environmentLeases.$inferSelect): boolean {
  return lease.provider === "local"
    ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
    : !hasRemoteTerminationReceipt(lease);
}
