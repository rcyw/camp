import type { ErrorRequestHandler } from "express";

// A legal completion contains a <=512 KiB change set, <=128 KiB of
// annotations, bounded summary/error strings and the small lease envelope.
// A verification report is <=256 KiB and cannot accompany an agent result.
export const CAMP_COMPLETION_BODY_MAX_BYTES = 1024 * 1024;
// JSON escapes can occupy six bytes per UTF-16 code unit; size these bounds
// for valid escaped text, not only its usual UTF-8 representation.
export const CAMP_TOOL_BODY_MAX_BYTES = 1024 * 1024;
export const CAMP_ROOM_BODY_MAX_BYTES = 512 * 1024;
export { CAMP_ARTIFACTS_MAX_BYTES } from "../services/camp/payloadLimits";
export const CAMP_COMPLETION_PATH = "/api/camp/worker/runs/:runId/complete";
export const CAMP_TOOL_PATHS = [
  "/api/camp/worker/runs/:runId/plan",
  "/api/camp/worker/runs/:runId/finalize",
  "/api/camp/worker/runs/:runId/questions",
  "/api/camp/worker/runs/:runId/questions/:questionId/answer",
  "/api/camp/worker/runs/:runId/questions/:questionId/escalate",
  "/api/camp/worker/runs/:runId/events",
  "/api/camp/worker/rooms/:roomId/messages",
];
export function campBodyErrorHandler(limitBytes: number): ErrorRequestHandler {
  return (error, _req, res, next) => {
    if ((error as { type?: unknown } | null)?.type === "entity.too.large") {
      res.status(413).json({ error: `Camp request body exceeds ${limitBytes} bytes`, code: "camp_body_too_large", limitBytes });
      return;
    }
    next(error);
  };
}
