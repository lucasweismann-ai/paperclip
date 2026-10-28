import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasProviderDispatchEvidence, leaseRetainsResources, readRunEnvironmentLeases } from "./run-dispatch-evidence.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;

/** A legacy run cancelled before provider dispatch, proven by absent dispatch
 * evidence rather than by its adapter or its execution stage.
 *
 * The acknowledged-cancellation receipt that normally retires a cancelled
 * legacy run is only written by a stop that found a live child process, so a
 * run cancelled before its PID was recorded can never earn one. Neither
 * surviving escape hatch reaches those rows either: the `settled` stage is
 * conjoined with "not a conversation adapter", and every legacy branch of
 * `isCancelledNativeStartup` requires a `paperclip_runner` claim. Without this
 * proof a single such row blocks every later pause of its agent forever,
 * because the stop scan has no time bound.
 *
 * Execution stage cannot carry the proof: a cancelled legacy run's stage is
 * overwritten with `settled` by its own executor's cleanup, which destroys the
 * `dispatching` marker. Run events are immutable, and every executor commits
 * one before a provider turn, so their absence is the durable evidence. This
 * admits nothing that reached dispatch: such a run has a PID, a session id, or
 * a dispatch event.
 */
export async function isCancelledBeforeProviderDispatch(
  db: Db, run: Run, coordinator: Coordinator | undefined,
): Promise<boolean> {
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || !run.finishedAt) return false;
  if (run.processPid || run.processGroupId || run.processStartedAt) return false;
  if (run.nativeSessionId || run.sessionIdAfter) return false;
  // A coordinator row or a live controller lease means an executor may still be
  // unwinding this run even though the row is already terminal.
  if (coordinator) return false;
  if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
  if ((await readRunEnvironmentLeases(db, run)).some(leaseRetainsResources)) return false;
  return !await hasProviderDispatchEvidence(db, run);
}
