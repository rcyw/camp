import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Copy } from "lucide-react";
import { Button, Input } from "@botiverse/raft-ui";
import { campApi, campError } from "./campApi";

/** Keep the once-visible credential in this room-bound component's memory only. */
export default function CampWorkerConnection({ roomId }: { roomId: string }) {
  const { formatMessage: t } = useIntl();
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const issue = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await campApi.workerToken(roomId);
      setToken(result.token);
      setCopied(false);
    } catch (failure) {
      setError(campError(failure) ?? t({ id: "camp.actionError" }));
    } finally { setBusy(false); }
  }, [roomId, busy, t]);
  const copy = useCallback(async () => {
    if (!token) return;
    try { await navigator.clipboard.writeText(token); setCopied(true); setError(null); }
    catch { setError(t({ id: "camp.copyError" })); }
  }, [token, t]);
  const hide = useCallback(() => { setToken(null); setCopied(false); }, []);

  return (
    <details className="rounded-xl border border-border-default p-4">
      <summary className="cursor-pointer text-sm font-medium">{t({ id: "camp.connectWorker" })}</summary>
      <p className="mt-3 text-sm text-foreground-hint">{t({ id: "camp.workerHelp" })}</p>
      <p className="mt-2 break-all font-mono text-xs">{t({ id: "camp.roomId" })}: {roomId}</p>
      {error && <p className="mt-3 text-sm text-danger-strong" role="alert">{error}</p>}
      {token ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input type="password" value={token} readOnly autoComplete="off" aria-label={t({ id: "camp.workerToken" })} />
          <Button variant="ghost" size="sm" onClick={copy}><Copy size={13} />{t({ id: copied ? "camp.copied" : "camp.copy" })}</Button>
          <Button variant="ghost" size="sm" onClick={hide}>{t({ id: "camp.hide" })}</Button>
        </div>
      ) : <Button className="mt-3" variant="outline" size="sm" disabled={busy} onClick={issue}>{t({ id: "camp.issueToken" })}</Button>}
    </details>
  );
}
