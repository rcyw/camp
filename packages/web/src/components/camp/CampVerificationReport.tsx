import { useIntl } from "react-intl";
import type { CampCandidate, CampVerificationPolicySnapshot, CampVerificationReceipt } from "../../../../camp-protocol/src/index.js";
import CampCandidateReference from "./CampCandidateReference";
import { visibleSourceText } from "./campDisplay";

const STATUS_LABELS = {
  not_required: "camp.verification.status.notRequired", not_run: "camp.verification.status.notRun", pending: "camp.verification.status.pending", queued: "camp.verification.status.pending", running: "camp.verification.status.running",
  passed: "camp.verification.status.passed", failed: "camp.verification.status.failed", cancelled: "camp.verification.status.cancelled", blocked: "camp.verification.status.blocked", unavailable: "camp.verification.status.unavailable",
} as const;

export function verificationStatusLabel(status: string) {
  return STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? "camp.verification.status.unavailable";
}

export function sameDisplayedCandidate(left: CampCandidate, right: CampCandidate): boolean {
  return left.projectId === right.projectId && left.refKind === right.refKind && left.refId === right.refId && left.rootId === right.rootId && left.imageId === right.imageId;
}

export default function CampVerificationReport({ status, receipt, candidate, policy }: {
  status: string;
  receipt: CampVerificationReceipt | null;
  candidate: CampCandidate;
  policy?: CampVerificationPolicySnapshot | null;
}) {
  const { formatMessage: t, formatNumber } = useIntl();
  const matches = receipt !== null && sameDisplayedCandidate(candidate, receipt.candidate) && (!policy || policy.digest === receipt.policyDigest);
  const confirmedStatus = status === "passed" && (!matches || receipt?.status !== "passed") ? "unavailable" : status;
  return (
    <section aria-label={t({ id: "camp.verification.report" })} className="rounded-lg border border-border-default p-4" data-testid="camp-verification-report" data-candidate-ref={receipt?.candidate.refId ?? candidate.refId} data-status={confirmedStatus}>
      <h5 className="text-sm font-medium">{t({ id: "camp.verification.report" })}</h5>
      <p className="mt-2 text-sm font-medium" role="status">{t({ id: verificationStatusLabel(confirmedStatus) })}</p>
      <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.verification.executionScope" })}</p>
      {receipt && !matches && <p className="mt-3 text-sm text-danger-strong" role="alert">{t({ id: "camp.verification.identityMismatch" })}</p>}
      {!receipt ? <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.verification.noReceipt" })}</p> : <>
        <p className="mt-3 text-xs"><CampCandidateReference candidate={receipt.candidate} /></p>
        <dl className="mt-3 grid gap-2 text-xs text-foreground-hint"><div><dt className="inline">{t({ id: "camp.verification.policyDigest" })}: </dt><dd className="inline break-all font-mono">{receipt.policyDigest}</dd></div><div><dt className="inline">{t({ id: "camp.verification.verifiedAt" })}: </dt><dd className="inline"><time dateTime={receipt.verifiedAt}>{receipt.verifiedAt}</time></dd></div></dl>
        <ol className="mt-3 flex flex-col gap-3">
          {receipt.checks.map(check => {
            const definition = policy?.policy.checks.find(value => value.id === check.id);
            return <li key={check.id} className="min-w-0 rounded border border-border-default p-3 text-xs" data-testid="camp-verification-check" data-check-id={check.id}>
              <h6 className="break-words font-medium">{definition?.label ?? check.id}</h6>
              <p className="mt-2 text-foreground-hint">{t({ id: definition ? definition.harness ? "camp.verification.externalHarness" : "camp.verification.candidateScripts" : "camp.verification.sourceUnknown" })}</p>
              {definition?.harness && <p className="mt-1 break-all font-mono text-foreground-hint">{definition.harness.id} · {definition.harness.sha256}</p>}
              <pre className="mt-2 overflow-x-auto rounded bg-layer-canvas p-2"><code>{visibleSourceText(JSON.stringify(check.argv), true)}</code></pre>
              <p className="mt-2">{t({ id: "camp.verification.exit" }, { code: check.exitCode === null ? "—" : String(check.exitCode), duration: formatNumber(check.durationMs) })}</p>
              {check.signal && <p className="mt-1">{t({ id: "camp.verification.signal" })}: {check.signal}</p>}
              {check.timedOut && <p className="mt-1 text-danger-strong">{t({ id: "camp.verification.timedOut" })}</p>}
              {check.oomKilled && <p className="mt-1 text-danger-strong">{t({ id: "camp.verification.oom" })}</p>}
              {check.outputTruncated && <p className="mt-2 text-foreground-secondary" role="status">{t({ id: "camp.verification.outputTruncated" })}</p>}
              <details className="mt-3" data-testid="camp-verification-check-log"><summary className="cursor-pointer font-medium">{t({ id: "camp.verification.logs" })}</summary><p className="mt-2 text-foreground-hint">{t({ id: "camp.verification.stdout" })}</p><pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-layer-canvas p-2">{visibleSourceText(check.stdout, true) || t({ id: "camp.verification.emptyLog" })}</pre><p className="mt-2 text-foreground-hint">{t({ id: "camp.verification.stderr" })}</p><pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-layer-canvas p-2">{visibleSourceText(check.stderr, true) || t({ id: "camp.verification.emptyLog" })}</pre></details>
            </li>;
          })}
        </ol>
      </>}
    </section>
  );
}
