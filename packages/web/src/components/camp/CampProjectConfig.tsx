import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import { Button, Input } from "@botiverse/raft-ui";
import { campApi, campError, campErrorCode } from "./campApi";
import type { CampRoom, CampSetup } from "./campApi";

export default function CampProjectConfig({ room, setup, canManage, onChanged }: { room: CampRoom; setup: CampSetup; canManage: boolean; onChanged(): void }) {
  const { formatMessage: t } = useIntl();
  const [draft, setDraft] = useState<{ project: CampRoom["project"]; digest: string } | null>(null);
  const [saving, setSaving] = useState(false), [conflict, setConflict] = useState(false), [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const stale = conflict || (draft !== null && draft.digest !== setup.projectDigest);
  const open = useCallback(() => { setDraft({ project: { ...room.project }, digest: setup.projectDigest }); setConflict(false); setError(null); }, [room.project, setup.projectDigest]);
  const close = useCallback(() => { setDraft(null); setError(null); setConflict(false); }, []);
  const editName = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const name = event.target.value;
    setDraft(current => current && { ...current, project: { ...current.project, name } });
  }, []);
  const editPath = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const repoPath = event.target.value;
    setDraft(current => current && { ...current, project: { ...current.project, repoPath } });
  }, []);
  const save = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current || !canManage || !setup.projectMutable || stale || !draft || !draft.project.name.trim() || !draft.project.repoPath?.trim().startsWith("/")) return;
    inFlight.current = true; setSaving(true); setError(null);
    try {
      await campApi.project(room.id, { ...draft.project, name: draft.project.name.trim(), repoPath: draft.project.repoPath.trim() }, draft.digest);
      close(); onChanged();
    } catch (failure) {
      const code = campErrorCode(failure);
      if (code === "project_changed" || code === "project_frozen") { setConflict(true); onChanged(); }
      else setError(campError(failure) ?? t({ id: "camp.setup.projectSaveFailed" }));
    } finally { inFlight.current = false; setSaving(false); }
  }, [canManage, setup.projectMutable, stale, draft, room.id, close, onChanged, t]);
  return <section aria-label={t({ id: "camp.setup.project" })} className="rounded-xl border border-border-default p-4" data-testid="camp-project-config">
    <header className="flex items-center justify-between gap-3"><h3 className="text-sm font-medium">{t({ id: "camp.setup.project" })}</h3>{canManage && setup.projectMutable && !draft && <Button size="sm" variant="outline" onClick={open}>{t({ id: "camp.setup.editProject" })}</Button>}</header>
    <p className="mt-3 text-sm">{room.project.name}</p>
    <p className="mt-1 break-all font-mono text-xs text-foreground-secondary">{room.project.repoPath ?? t({ id: "camp.setup.noSource" })}</p>
    <p className="mt-3 text-xs text-foreground-hint">{t({ id: setup.projectMutable ? "camp.setup.projectMutable" : "camp.setup.projectFrozen" })}</p>
    {draft && canManage && <form className="mt-4 flex flex-col gap-3 border-t border-border-default pt-4" data-testid="camp-project-form" onSubmit={save}>
      {(!setup.projectMutable || stale) && <p role="alert" className="text-sm text-danger-strong">{t({ id: !setup.projectMutable ? "camp.setup.projectDraftFrozen" : "camp.setup.projectChanged" })}</p>}
      <label className="flex flex-col gap-1 text-sm">{t({ id: "camp.projectName" })}<Input value={draft.project.name} maxLength={200} required disabled={saving} onChange={editName} /></label>
      <label className="flex flex-col gap-1 text-sm">{t({ id: "camp.projectFolder" })}<Input value={draft.project.repoPath ?? ""} aria-label={t({ id: "camp.projectFolder" })} maxLength={4096} required pattern="/.*" disabled={saving} onChange={editPath} /><span className="text-xs text-foreground-hint">{t({ id: "camp.projectFolderHelp" })}</span></label>
      <div className="flex gap-2"><Button size="sm" type="submit" disabled={saving || stale || !setup.projectMutable}>{t({ id: saving ? "camp.setup.savingProject" : "camp.setup.saveProject" })}</Button><Button size="sm" type="button" variant="ghost" disabled={saving} onClick={close}>{t({ id: "camp.policy.close" })}</Button></div>
    </form>}
    {error && <p role="alert" className="mt-3 text-sm text-danger-strong">{error}</p>}
  </section>;
}
