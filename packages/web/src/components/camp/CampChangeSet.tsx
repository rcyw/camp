import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import type { CampChangeEntry, CampChangeSet, CampChangeSide } from "../../../../camp-protocol/src/index.js";
import CampCandidateReference from "./CampCandidateReference";
import { visibleSourceText } from "./campDisplay";

const CHANGE_LABELS = {
  added: "camp.diff.added", modified: "camp.diff.modified", deleted: "camp.diff.deleted", type_changed: "camp.diff.typeChanged",
} as const;

function FileSide({ side, label }: { side: CampChangeSide | null; label: string }) {
  const { formatMessage: t, formatNumber } = useIntl();
  return (
    <div className="min-w-0 rounded border border-border-default p-3 text-xs">
      <dt className="font-medium">{label}</dt>
      <dd className="mt-2 break-words text-foreground-secondary">
        {!side ? t({ id: "camp.diff.absent" }) : <>
          <p>{t({ id: side.type === "file" ? "camp.diff.file" : side.type === "directory" ? "camp.diff.directory" : "camp.diff.symlink" })}</p>
          <p className="mt-1">{t({ id: "camp.diff.mode" })}: <span className="font-mono">{side.mode.toString(8)}</span></p>
          <p className="mt-1">{t({ id: "camp.diff.bytes" }, { count: formatNumber(side.size) })}</p>
          {side.type === "symlink" && <p className="mt-1 break-all font-mono">{visibleSourceText(side.target)}</p>}
        </>}
      </dd>
    </div>
  );
}

function FilePreview({ entry }: { entry: CampChangeEntry }) {
  const { formatMessage: t } = useIntl();
  return (
    <section className="mt-3 min-w-0 rounded-lg border border-border-default p-3" aria-label={t({ id: "camp.diff.preview" })}>
      <h6 className="break-all font-mono text-sm">{visibleSourceText(entry.path)}</h6>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        <FileSide side={entry.before} label={t({ id: "camp.diff.before" })} />
        <FileSide side={entry.after} label={t({ id: "camp.diff.after" })} />
      </dl>
      {entry.modeChanged && <p className="mt-3 text-xs text-foreground-secondary">{t({ id: "camp.diff.modeChanged" })}</p>}
      {entry.patchTruncated && <p className="mt-3 text-xs text-foreground-secondary" role="status">{t({ id: "camp.diff.patchTruncated" })}</p>}
      {entry.binary ? <p className="mt-3 text-sm text-foreground-hint">{t({ id: "camp.diff.binaryHelp" })}</p>
        : entry.patch !== null ? <pre className="mt-3 max-h-96 overflow-auto rounded bg-layer-surface p-3 text-xs"><code>{visibleSourceText(entry.patch, true)}</code></pre>
          : <p className="mt-3 text-sm text-foreground-hint">{t({ id: "camp.diff.previewUnavailable" })}</p>}
      {entry.previewReason && <p className="mt-2 break-words text-xs text-foreground-hint">{t({ id: "camp.diff.previewReason" })}: {visibleSourceText(entry.previewReason)}</p>}
    </section>
  );
}

function FileEntry({ entry, selected, onSelect }: { entry: CampChangeEntry; selected: boolean; onSelect(path: string): void }) {
  const { formatMessage: t } = useIntl();
  const select = useCallback(() => onSelect(entry.path), [entry.path, onSelect]);
  return <li className="border-b border-border-default last:border-b-0" data-testid="camp-change-entry" data-path={entry.path}>
    <Button type="button" variant="ghost" size="sm" className="h-auto w-full justify-start gap-2 whitespace-normal p-3 text-left" aria-pressed={selected} onClick={select}>
      <span className="shrink-0 text-xs">{t({ id: CHANGE_LABELS[entry.change] })}</span>
      <span className="min-w-0 break-all font-mono text-xs">{visibleSourceText(entry.path)}</span>
      {entry.binary && <span className="shrink-0 text-xs text-foreground-hint">{t({ id: "camp.diff.binary" })}</span>}
      {entry.modeChanged && <span className="shrink-0 text-xs text-foreground-hint">{t({ id: "camp.diff.mode" })}</span>}
    </Button>
  </li>;
}

/** One bounded, recorded comparison. Files are never fetched by source path. */
export default function CampChangeSetView({ changeSet }: { changeSet: CampChangeSet }) {
  const { formatMessage: t } = useIntl();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected = changeSet.entries.find(entry => entry.path === selectedPath);
  return (
    <section className="min-w-0" aria-label={t({ id: "camp.diff.title" })} data-testid="camp-change-set">
      <h5 className="font-medium">{t({ id: "camp.diff.title" })}</h5>
      <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
        <div className="min-w-0"><dt className="mb-1 text-foreground-hint">{t({ id: "camp.diff.baseline" })}</dt><dd><CampCandidateReference candidate={changeSet.base} /></dd></div>
        <div className="min-w-0"><dt className="mb-1 text-foreground-hint">{t({ id: "camp.diff.target" })}</dt><dd><CampCandidateReference candidate={changeSet.target} /></dd></div>
      </dl>
      <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.diff.stats" }, changeSet.stats)}</p>
      {changeSet.truncated && <p className="mt-3 text-sm text-foreground-secondary" role="status">{t({ id: "camp.diff.truncated" })}</p>}
      {changeSet.entries.length === 0 ? <p className="mt-3 text-sm text-foreground-hint">{t({ id: changeSet.truncated ? "camp.diff.emptyPartial" : "camp.diff.empty" })}</p> : <>
        <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.diff.selectHelp" })}</p>
        <ol className="mt-2 max-h-72 overflow-auto rounded-lg border border-border-default">
          {changeSet.entries.map(entry => <FileEntry key={entry.path} entry={entry} selected={selectedPath === entry.path} onSelect={setSelectedPath} />)}
        </ol>
        {selected && <FilePreview entry={selected} />}
      </>}
      <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.diff.textSafety" })}</p>
    </section>
  );
}
