import { useIntl } from "react-intl";
import type { CampGoal } from "./campApi";
import { usesExecutionPool } from "./campPlanMode";

/** A frozen admission declaration. It does not report live cgroup utilization. */
export default function CampExecutionPool({ goal }: { goal: CampGoal }) {
  const { formatMessage: t, formatNumber } = useIntl();
  if (!usesExecutionPool(goal.planMode)) return null;
  const pool = goal.executionPool;
  return <section className="rounded-lg border border-border-default p-4" aria-label={t({ id: "camp.pool.title" })} data-testid="camp-execution-pool" data-pool-id={pool?.poolId}>
    <h5 className="text-sm font-medium">{t({ id: "camp.pool.title" })}</h5>
    <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.pool.scope" })}</p>
    {!pool ? <p className="mt-2 text-sm text-foreground-secondary">{t({ id: "camp.pool.unassigned" })}</p> : <>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div><dt className="text-foreground-hint">{t({ id: "camp.pool.id" })}</dt><dd className="mt-1 break-all font-mono">{pool.poolId}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.pool.storage" })}</dt><dd className="mt-1 break-all font-mono">{pool.storageId}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.pool.parallel" })}</dt><dd className="mt-1">{pool.maxParallel}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.pool.containers" })}</dt><dd className="mt-1">{t({ id: "camp.pool.containerLimit" }, { count: pool.resources.maxContainers })}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.pool.cpu" })}</dt><dd className="mt-1">{t({ id: "camp.pool.cpuValue" }, { count: formatNumber(pool.resources.cpuMillis / 1000) })}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.pool.memory" })}</dt><dd className="mt-1">{t({ id: "camp.pool.memoryValue" }, { count: formatNumber(pool.resources.memoryBytes / 1048576) })}</dd></div>
        <div><dt className="text-foreground-hint">{t({ id: "camp.pool.pids" })}</dt><dd className="mt-1">{formatNumber(pool.resources.pidsLimit)}</dd></div>
      </dl>
      <ol className="mt-3 flex flex-col gap-1 text-xs">{pool.workerIds.map((workerId, index) => <li key={workerId} className="break-all" data-testid="camp-pool-lane">{t({ id: "camp.run.lane" }, { lane: index + 1 })}: <code>{workerId}</code></li>)}</ol>
      <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.pool.declarationHelp" })}</p>
    </>}
  </section>;
}
