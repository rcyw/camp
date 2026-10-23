import { useCallback, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import { Copy } from "lucide-react";
import { Button, Input } from "@botiverse/raft-ui";
import { campApi, campError } from "./campApi";
import { WORKER_COMMANDS, workerEnvironment, workerSettingsValid } from "./campWorkerConfig";

function WorkerCommand({ commandKey, copied, onCopy }: { commandKey: keyof typeof WORKER_COMMANDS; copied: boolean; onCopy(key: keyof typeof WORKER_COMMANDS): Promise<void> }) {
  const { formatMessage: t } = useIntl();
  const copy = useCallback(() => { void onCopy(commandKey); }, [onCopy, commandKey]);
  return <li>
    <div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">{t({ id: `camp.setup.command.${commandKey}` })}</p><Button size="sm" variant="ghost" onClick={copy} aria-label={t({ id: "camp.setup.copyCommand" }, { command: t({ id: `camp.setup.command.${commandKey}` }) })}>{t({ id: copied ? "camp.copied" : "camp.copy" })}</Button></div>
    <pre className="mt-2 overflow-x-auto rounded bg-layer-surface p-3 text-xs" data-testid={`camp-worker-command-${commandKey}`}><code>{WORKER_COMMANDS[commandKey]}</code></pre>
    {(commandKey === "reap" || commandKey === "reapApply") && <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.setup.reapHelp" })}</p>}
  </li>;
}

/** Keep the once-visible credential in this room-bound component's memory only. */
export default function CampWorkerConnection({ roomId, expanded = false }: { roomId: string; expanded?: boolean }) {
  return <WorkerConnectionState key={roomId} roomId={roomId} expanded={expanded} />;
}

function WorkerConnectionState({ roomId, expanded }: { roomId: string; expanded: boolean }) {
  const { formatMessage: t } = useIntl();
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const issuing = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [apiUrl, setApiUrl] = useState("");
  const [workerId, setWorkerId] = useState(`camp-room-${roomId.slice(0, 8)}`);
  const [runtimeHome, setRuntimeHome] = useState(".camp/runtime");
  const [imageId, setImageId] = useState("");
  const [bundlePath, setBundlePath] = useState("");
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const validSettings = workerSettingsValid(apiUrl.trim(), workerId.trim(), runtimeHome.trim(), imageId.trim(), bundlePath.trim());
  const editApi = useCallback((event: ChangeEvent<HTMLInputElement>) => setApiUrl(event.target.value), []);
  const editWorkerId = useCallback((event: ChangeEvent<HTMLInputElement>) => setWorkerId(event.target.value), []);
  const editRuntimeHome = useCallback((event: ChangeEvent<HTMLInputElement>) => setRuntimeHome(event.target.value), []);
  const editImage = useCallback((event: ChangeEvent<HTMLInputElement>) => setImageId(event.target.value), []);
  const editBundle = useCallback((event: ChangeEvent<HTMLInputElement>) => setBundlePath(event.target.value), []);
  const issue = useCallback(async () => {
    if (issuing.current) return;
    issuing.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await campApi.workerToken(roomId);
      setToken(result.token);
      setCopied(false);
    } catch (failure) {
      setError(campError(failure) ?? t({ id: "camp.actionError" }));
    } finally { issuing.current = false; setBusy(false); }
  }, [roomId, t]);
  const copy = useCallback(async () => {
    if (!token) return;
    try { await navigator.clipboard.writeText(token); setCopied(true); setError(null); }
    catch { setError(t({ id: "camp.copyError" })); }
  }, [token, t]);
  const hide = useCallback(() => { setToken(null); setCopied(false); }, []);
  const download = useCallback(() => {
    if (!token || !validSettings) return;
    try {
      const contents = workerEnvironment({ apiUrl: apiUrl.trim(), workerId: workerId.trim(), runtimeHome: runtimeHome.trim(), token, imageId: imageId.trim(), bundlePath: bundlePath.trim() });
      const url = URL.createObjectURL(new Blob([contents], { type: "text/plain;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `camp-worker-${roomId.replace(/[^A-Za-z0-9_-]/g, "_")}.env`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); setError(null);
    } catch { setError(t({ id: "camp.setup.configFailed" })); }
  }, [token, validSettings, apiUrl, workerId, runtimeHome, imageId, bundlePath, roomId, t]);
  const copyCommand = useCallback(async (key: keyof typeof WORKER_COMMANDS) => {
    try { await navigator.clipboard.writeText(WORKER_COMMANDS[key]); setCopiedCommand(key); setError(null); }
    catch { setError(t({ id: "camp.copyError" })); }
  }, [t]);

  return (
    <details className="rounded-xl border border-border-default p-4" open={expanded} data-testid="camp-worker-connection">
      <summary className="cursor-pointer text-sm font-medium">{t({ id: "camp.connectWorker" })}</summary>
      <p className="mt-3 text-sm text-foreground-hint">{t({ id: "camp.workerHelp" })}</p>
      <p className="mt-2 break-all font-mono text-xs">{t({ id: "camp.roomId" })}: {roomId}</p>
      <div className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">{t({ id: "camp.setup.apiUrl" })}<Input value={apiUrl} onChange={editApi} type="url" maxLength={2048} placeholder="http://127.0.0.1:13018" autoComplete="off" data-testid="camp-worker-api" /><span className="text-xs text-foreground-hint">{t({ id: "camp.setup.apiHelp" })}</span></label>
        <label className="flex flex-col gap-1 text-sm">{t({ id: "camp.setup.workerId" })}<Input value={workerId} onChange={editWorkerId} maxLength={200} autoComplete="off" data-testid="camp-worker-id" /></label>
        <label className="flex flex-col gap-1 text-sm">{t({ id: "camp.setup.runtimeHome" })}<Input value={runtimeHome} onChange={editRuntimeHome} maxLength={4096} autoComplete="off" data-testid="camp-worker-home" /><span className="text-xs text-foreground-hint">{t({ id: "camp.setup.identityHelp" })}</span></label>
        <label className="flex flex-col gap-1 text-sm">{t({ id: "camp.setup.imageId" })}<Input value={imageId} onChange={editImage} maxLength={71} autoComplete="off" data-testid="camp-worker-image" /><span className="text-xs text-foreground-hint">{t({ id: "camp.setup.imageHelp" })}</span></label>
        <label className="flex flex-col gap-1 text-sm">{t({ id: "camp.setup.bundlePath" })}<Input value={bundlePath} onChange={editBundle} maxLength={4096} autoComplete="off" data-testid="camp-worker-bundle" /><span className="text-xs text-foreground-hint">{t({ id: "camp.setup.bundleHelp" })}</span></label>
        {apiUrl.trim() && !validSettings && <p role="status" className="text-xs text-foreground-hint">{t({ id: "camp.setup.configFailed" })}</p>}
      </div>
      {error && <p className="mt-3 text-sm text-danger-strong" role="alert">{error}</p>}
      {token ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input type="password" value={token} readOnly autoComplete="off" aria-label={t({ id: "camp.workerToken" })} />
          <Button variant="ghost" size="sm" onClick={copy}><Copy size={13} />{t({ id: copied ? "camp.copied" : "camp.copy" })}</Button>
          <Button variant="ghost" size="sm" onClick={hide}>{t({ id: "camp.hide" })}</Button>
          <Button variant="outline" size="sm" disabled={!validSettings} onClick={download} data-testid="camp-worker-env-download">{t({ id: "camp.setup.downloadConfig" })}</Button>
        </div>
      ) : <Button className="mt-3" variant="outline" size="sm" disabled={busy} onClick={issue}>{t({ id: "camp.issueToken" })}</Button>}
      <p className="mt-3 text-xs text-foreground-hint">{t({ id: "camp.setup.configHelp" })}</p>
      <p className="mt-2 text-xs text-foreground-hint">{t({ id: "camp.setup.modelHelp" })}</p>
      <ol className="mt-4 flex flex-col gap-4">{(Object.keys(WORKER_COMMANDS) as Array<keyof typeof WORKER_COMMANDS>).map(key => <WorkerCommand key={key} commandKey={key} copied={copiedCommand === key} onCopy={copyCommand} />)}</ol>
    </details>
  );
}
