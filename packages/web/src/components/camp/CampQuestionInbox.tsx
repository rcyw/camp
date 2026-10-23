import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import { Button, Textarea } from "@botiverse/raft-ui";
import { CAMP_LIMITS } from "../../../../camp-protocol/src/index.js";
import { campApi, campError } from "./campApi";
import type { CampQuestion } from "./campApi";

export function CampQuestionCard({ roomId, question, onAnswered }: { roomId: string; question: CampQuestion; onAnswered(): void }) {
  const { formatMessage: t } = useIntl();
  const [answer, setAnswer] = useState("");
  const [sentAnswer, setSentAnswer] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const answered = question.status === "answered" || sentAnswer !== null;
  const pending = !answered && question.status !== "cancelled";
  const edit = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setAnswer(event.target.value), []);
  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!pending || !question.canAnswer || !answer.trim() || inFlight.current) return;
    const submitted = answer.trim();
    inFlight.current = true; setSending(true); setError(null);
    try {
      await campApi.answerQuestion(roomId, question.id, submitted);
      setSentAnswer(submitted); setAnswer(""); onAnswered();
    } catch (failure) { setError(campError(failure) ?? t({ id: "camp.question.answerFailed" })); }
    finally { inFlight.current = false; setSending(false); }
  }, [pending, question.canAnswer, question.id, answer, roomId, onAnswered, t]);
  const target = question.needsHuman ? t({ id: "camp.question.human" }) : question.toRole ? t({ id: `camp.role.${question.toRole}` }) : t({ id: "camp.title" });
  return (
    <article className="rounded-lg border border-border-default bg-layer-surface p-4" data-testid={`camp-question-${question.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-hint">
        <p>{t({ id: "camp.question.route" }, { from: t({ id: `camp.role.${question.fromRole}` }), to: target })}</p>
        <span>{t({ id: answered ? "camp.question.status.answered" : `camp.question.status.${question.status}` })}</span>
      </div>
      {pending && question.status === "awaiting_human" && <p className="mt-2 text-sm font-medium" role="status">{t({ id: "camp.question.decisionNeeded" })}</p>}
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{question.content}</p>
      {answered && <div className="mt-3 border-t border-border-default pt-3 text-sm"><p className="mb-1 text-xs font-medium text-foreground-hint">{t({ id: "camp.question.answer" })}</p><p className="whitespace-pre-wrap break-words">{question.answer ?? sentAnswer}</p></div>}
      {pending && question.canAnswer && (
        <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
          <label htmlFor={`camp-answer-${question.id}`} className="text-xs font-medium">{t({ id: "camp.question.yourAnswer" })}</label>
          <Textarea id={`camp-answer-${question.id}`} value={answer} onChange={edit} maxLength={CAMP_LIMITS.text} rows={2} required />
          {error && <p role="alert" className="text-sm text-danger-strong">{error}</p>}
          <Button type="submit" size="sm" disabled={sending || !answer.trim()}>{t({ id: sending ? "camp.question.sending" : "camp.question.sendAnswer" })}</Button>
        </form>
      )}
      {pending && !question.canAnswer && <p className="mt-2 text-xs text-foreground-hint">{t({ id: question.status === "pending" ? "camp.question.preparing" : question.needsHuman ? "camp.question.answerUnavailable" : "camp.question.roleResponding" })}</p>}
    </article>
  );
}

export default function CampQuestionInbox({ roomId, questions, onAnswered }: { roomId: string; questions: CampQuestion[]; onAnswered(): void }) {
  const { formatMessage: t } = useIntl();
  if (questions.length === 0) return null;
  const pending = questions.filter(question => !["answered", "cancelled"].includes(question.status)).sort((a, b) => Number(b.needsHuman) - Number(a.needsHuman) || a.createdAt.localeCompare(b.createdAt));
  const history = questions.filter(question => ["answered", "cancelled"].includes(question.status));
  return (
    <section aria-label={t({ id: "camp.question.inbox" })} className="flex flex-col gap-3">
      <h3 className="font-medium">{t({ id: "camp.question.inbox" })}</h3>
      <p className="text-xs text-foreground-hint">{t({ id: "camp.question.inboxHelp" })}</p>
      {pending.map(question => <CampQuestionCard key={question.id} roomId={roomId} question={question} onAnswered={onAnswered} />)}
      {history.length > 0 && <details><summary className="mb-3 cursor-pointer text-sm text-foreground-hint">{t({ id: "camp.question.history" }, { count: history.length })}</summary><div className="flex flex-col gap-3">{history.map(question => <CampQuestionCard key={question.id} roomId={roomId} question={question} onAnswered={onAnswered} />)}</div></details>}
    </section>
  );
}
