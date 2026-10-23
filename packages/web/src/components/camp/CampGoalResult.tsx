import { useCallback, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Download, ArrowRight } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import { campApi, campError } from "./campApi";
import type { CampGoal } from "./campApi";
import CampCandidateReference, { candidateRefId } from "./CampCandidateReference";

export function resultManifestFilename(goalId: string): string { return `camp-result-${goalId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`; }
export function resultExportCommand(goalId: string): string {
  const safe = goalId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `node packages/camp-runtime/scripts/export.mjs --manifest ./${resultManifestFilename(goalId)} --output ./camp-export-${safe}`;
}

export function goalResultReady(goal: CampGoal): boolean {
  const candidateReady = goal.status === "completed" && Boolean(candidateRefId(goal.finalCandidate));
  return candidateReady && (goal.resultReady ?? (goal.protocolVersion ?? 1) < 2);
}

export default function CampGoalResult({ goal, canContinue, onContinue }: { goal: CampGoal; canContinue: boolean; onContinue?(goal: CampGoal): void }) {
  const { formatMessage: t } = useIntl();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const candidate = goal.finalCandidate;
  const ready = goalResultReady(goal);
  const download = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true; setDownloading(true); setError(null);
    try {
      const manifest = await campApi.result(goal.roomId, goal.id);
      if (!manifest.resultReady || !candidateRefId(manifest.candidate)) throw new Error("result_not_ready");
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: "application/json;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = resultManifestFilename(goal.id);
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (failure) { setError(campError(failure) ?? t({ id: "camp.result.downloadFailed" })); }
    finally { inFlight.current = false; setDownloading(false); }
  }, [goal.roomId, goal.id, t]);
  const next = useCallback(() => { if (ready && canContinue) onContinue?.(goal); }, [ready, canContinue, onContinue, goal]);
  if (!candidate && !goal.summary) return null;
  return (
    <section className="rounded-lg border border-border-default bg-layer-canvas p-4" aria-label={t({ id: "camp.result.title" })}>
      <h5 className="font-medium">{t({ id: "camp.result.title" })}</h5>
      {goal.summary && <>
        <p className="mt-3 text-xs font-medium text-foreground-hint">{t({ id: "camp.result.summary" })}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{goal.summary.summary}</p>
        {goal.summary.evidence && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-foreground-secondary">{goal.summary.evidence}</p>}
        {goal.summary.remaining.length > 0 && <div className="mt-3 text-sm"><p className="font-medium">{t({ id: "camp.result.remaining" })}</p><ul className="mt-1 list-inside list-disc">{goal.summary.remaining.map((item, index) => <li key={index} className="break-words">{item}</li>)}</ul></div>}
      </>}
      {candidate && <dl className="mt-3 grid gap-1 text-xs text-foreground-hint"><div><dt className="inline">{t({ id: "camp.result.candidate" })}: </dt><dd className="inline"><CampCandidateReference candidate={candidate} /></dd></div><div><dt className="inline">{t({ id: "camp.result.root" })}: </dt><dd className="inline break-all font-mono">{candidate.rootId}</dd></div></dl>}
      {ready && <>
        <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.result.exportHelp" })}</p>
        <pre className="mt-2 overflow-x-auto rounded border border-border-default bg-layer-surface p-3 text-xs"><code>{resultExportCommand(goal.id)}</code></pre>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={downloading} onClick={download}><Download size={13} />{t({ id: "camp.result.downloadManifest" })}</Button>
          {canContinue && onContinue && <Button size="sm" variant="outline" onClick={next}><ArrowRight size={13} />{t({ id: "camp.result.continue" })}</Button>}
        </div>
      </>}
      {error && <p role="alert" className="mt-2 text-sm text-danger-strong">{error}</p>}
    </section>
  );
}
