import { useIntl } from "react-intl";
import type { CampReference } from "./campApi";

export function candidateRefId(candidate: CampReference | null | undefined): string | undefined {
  return candidate?.refId ?? candidate?.commitId ?? candidate?.layerId;
}

export function candidateRefLabel(candidate: CampReference): "camp.candidate.layer" | "camp.candidate.commit" {
  return candidate.refKind === "layer" || (!candidate.refKind && candidate.layerId) ? "camp.candidate.layer" : "camp.candidate.commit";
}

export default function CampCandidateReference({ candidate }: { candidate: CampReference }) {
  const { formatMessage: t } = useIntl();
  const id = candidateRefId(candidate);
  if (!id) return null;
  return <span className="inline-flex max-w-full flex-wrap items-center gap-2"><span className="rounded border border-border-default px-1.5 py-0.5 text-xs">{t({ id: candidateRefLabel(candidate) })}</span><span className="break-all font-mono">{id}</span></span>;
}
