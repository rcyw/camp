import { useCallback, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import { Button, Input, Textarea } from "@botiverse/raft-ui";
import type { CampVerificationPolicy, CampVerificationPolicySnapshot } from "../../../../camp-protocol/src/index.js";
import { CAMP_VERIFICATION_LIMITS } from "../../../../camp-protocol/src/index.js";
import { campApi, campError, campErrorCode } from "./campApi";
import { visibleSourceText } from "./campDisplay";

function PolicyEditor({ current, stale, onSave, onClose }: {
  current: CampVerificationPolicySnapshot | null;
  stale: boolean;
  onSave(policy: CampVerificationPolicy): Promise<boolean>;
  onClose(): void;
}) {
  const { formatMessage: t } = useIntl();
  const commandHelpId = useId();
  const [name, setName] = useState(current?.policy.name ?? t({ id: "camp.policy.defaultName" }));
  const [preset, setPreset] = useState(current ? "existing" : "node");
  const [command, setCommand] = useState("");
  const [timeout, setTimeoutSeconds] = useState("120");
  const [repairs, setRepairs] = useState(String(current?.policy.maxRepairAttempts ?? 1));
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const replacing = current !== null && preset !== "existing";
  const editName = useCallback((event: ChangeEvent<HTMLInputElement>) => setName(event.target.value), []);
  const editCommand = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setCommand(event.target.value), []);
  const editTimeout = useCallback((event: ChangeEvent<HTMLInputElement>) => setTimeoutSeconds(event.target.value), []);
  const editRepairs = useCallback((event: ChangeEvent<HTMLInputElement>) => setRepairs(event.target.value), []);
  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    const seconds = Number(timeout), maxRepairAttempts = Number(repairs);
    if (inFlight.current || stale || !name.trim() || (replacing && !replaceConfirmed) || !Number.isSafeInteger(maxRepairAttempts) || maxRepairAttempts < 0 || maxRepairAttempts > 3) return;
    if (preset !== "existing" && (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 120 || (preset === "shell" && !command.trim()))) return;
    const policy: CampVerificationPolicy = {
      id: current?.policy.id ?? "project-checks", revision: (current?.policy.revision ?? 0) + 1, name: name.trim(), maxRepairAttempts,
      checks: preset === "existing" && current ? current.policy.checks : [{ id: preset === "node" ? "node-tests" : "project-command", label: preset === "node" ? t({ id: "camp.policy.nodePreset" }) : name.trim(), argv: preset === "node" ? ["node", "--test"] : ["/bin/sh", "-c", command.trim()], timeoutMs: seconds * 1000 }],
    };
    inFlight.current = true; setSaving(true);
    try { if (await onSave(policy)) onClose(); }
    finally { inFlight.current = false; setSaving(false); }
  }, [name, preset, command, timeout, repairs, replacing, replaceConfirmed, current, stale, onSave, onClose, t]);
  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-3 border-t border-border-default pt-4" data-testid="camp-policy-form">
      {stale && <p role="alert" className="text-sm text-danger-strong">{t({ id: "camp.policy.changed" })}</p>}
      <label className="flex flex-col gap-1 text-sm">{t({ id: "camp.policy.name" })}<Input value={name} onChange={editName} maxLength={200} required disabled={saving} /></label>
      <label className="flex flex-col gap-1 text-sm">{t({ id: "camp.policy.checks" })}
        <select value={preset} disabled={saving} onChange={event => { setPreset(event.target.value); setReplaceConfirmed(false); }} className="rounded border border-border-default bg-layer-canvas p-2 text-sm">
          {current && <option value="existing">{t({ id: "camp.policy.keepExisting" })}</option>}
          <option value="node">{t({ id: "camp.policy.nodePreset" })}</option>
          <option value="shell">{t({ id: "camp.policy.shellPreset" })}</option>
        </select>
      </label>
      {preset === "shell" && <label className="flex flex-col gap-1 text-sm">{t({ id: "camp.policy.command" })}<Textarea aria-label={t({ id: "camp.policy.command" })} aria-describedby={commandHelpId} value={command} onChange={editCommand} rows={3} maxLength={CAMP_VERIFICATION_LIMITS.maxArgumentLength} required disabled={saving} /><span id={commandHelpId} className="text-xs text-foreground-hint">{t({ id: "camp.policy.commandHelp" })}</span></label>}
      {preset !== "existing" && <label className="flex flex-col gap-1 text-sm">{t({ id: "camp.policy.timeout" })}<Input type="number" value={timeout} onChange={editTimeout} min={1} max={120} step={1} required disabled={saving} /></label>}
      <label className="flex flex-col gap-1 text-sm">{t({ id: "camp.policy.repairs" })}<Input type="number" value={repairs} onChange={editRepairs} min={0} max={3} step={1} required disabled={saving} /></label>
      {replacing && <label className="flex items-start gap-2 text-sm text-foreground-secondary"><input type="checkbox" checked={replaceConfirmed} onChange={event => setReplaceConfirmed(event.target.checked)} required disabled={saving} className="mt-1" /><span>{t({ id: "camp.policy.confirmReplace" })}</span></label>}
      <p className="text-xs text-foreground-hint">{t({ id: "camp.policy.futureOnly" })}</p>
      <div className="flex gap-2"><Button type="submit" size="sm" disabled={saving || stale || !name.trim() || (replacing && !replaceConfirmed)}>{t({ id: saving ? "camp.policy.saving" : "camp.policy.save" })}</Button><Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onClose}>{t({ id: "camp.policy.close" })}</Button></div>
    </form>
  );
}

export default function CampVerificationPolicyConfig({ roomId, current, canManage, onSaved }: {
  roomId: string;
  current: CampVerificationPolicySnapshot | null;
  canManage: boolean;
  onSaved(): void;
}) {
  const { formatMessage: t } = useIntl();
  const [editing, setEditing] = useState<{ baseline: CampVerificationPolicySnapshot | null } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => { setEditing(null); setError(null); setConflict(false); }, []);
  const open = useCallback(() => { setEditing({ baseline: current }); setError(null); setConflict(false); }, [current]);
  const stale = conflict || (editing !== null && (editing.baseline?.digest ?? null) !== (current?.digest ?? null));
  const save = useCallback(async (policy: CampVerificationPolicy) => {
    if (!canManage || !editing || stale) return false;
    setError(null);
    try { await campApi.verificationPolicy(roomId, policy, editing.baseline?.digest ?? null); onSaved(); return true; }
    catch (failure) {
      if (campErrorCode(failure) === "verification_policy_changed") { setConflict(true); onSaved(); }
      else setError(campError(failure) ?? t({ id: "camp.policy.saveFailed" }));
      return false;
    }
  }, [roomId, canManage, editing, stale, onSaved, t]);
  return (
    <section aria-label={t({ id: "camp.policy.title" })} className="rounded-xl border border-border-default p-4" data-testid="camp-verification-policy">
      <header className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t({ id: "camp.policy.title" })}</h3>{canManage && !editing && <Button type="button" variant="outline" size="sm" data-testid="camp-policy-configure" onClick={open}>{t({ id: current ? "camp.policy.edit" : "camp.policy.configure" })}</Button>}</header>
      {!current ? <p className="mt-3 text-sm text-foreground-secondary">{t({ id: canManage ? "camp.policy.required" : "camp.policy.adminRequired" })}</p> : <>
        <p className="mt-3 text-sm">{current.policy.name} · {t({ id: "camp.policy.revision" }, { revision: current.policy.revision })}</p>
        <p className="mt-1 break-all font-mono text-xs text-foreground-hint">{current.digest}</p>
        <ul className="mt-3 flex flex-col gap-2">{current.policy.checks.map(check => <li key={check.id} className="rounded border border-border-default p-3 text-xs"><p className="font-medium">{check.label}</p><pre className="mt-1 overflow-x-auto font-mono">{visibleSourceText(JSON.stringify(check.argv), true)}</pre><p className="mt-2 text-foreground-hint">{t({ id: check.harness ? "camp.verification.externalHarness" : "camp.verification.candidateScripts" })}</p>{check.harness && <p className="mt-1 break-all font-mono text-foreground-hint">{check.harness.id} · {check.harness.sha256}</p>}</li>)}</ul>
        <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.policy.futureOnly" })}</p>
      </>}
      {editing && canManage && <PolicyEditor current={editing.baseline} stale={stale} onSave={save} onClose={close} />}
      {error && <p className="mt-3 text-sm text-danger-strong" role="alert">{error}</p>}
    </section>
  );
}
