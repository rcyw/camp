/** Node --env-file values, never shell interpolation or browser persistence. */
function environmentValue(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("invalid_config");
  // Node accepts all three delimiters. Double-quoted backslashes can expand
  // into newlines; prefer literal delimiters and reject ambiguous values.
  for (const quote of ["'", "`", '"']) if (!value.includes(quote) && !(quote === '"' && value.includes("\\"))) return `${quote}${value}${quote}`;
  throw new Error("invalid_config");
}

export function workerSettingsValid(apiUrl: string, workerId: string, runtimeHome: string, imageId = "", bundlePath = ""): boolean {
  try {
    const url = new URL(apiUrl);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && !url.pathname.replace(/\/+$/, "").toLowerCase().endsWith("/api")
      && apiUrl.length <= 2048 && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(workerId)
      && runtimeHome.length > 0 && runtimeHome.length <= 4096 && Boolean(environmentValue(runtimeHome))
      && (!imageId || /^sha256:[a-f0-9]{64}$/.test(imageId))
      && (!bundlePath || (bundlePath.length <= 4096 && Boolean(environmentValue(bundlePath))));
  } catch { return false; }
}

export function workerEnvironment({ apiUrl, workerId, runtimeHome, token, imageId = "", bundlePath = "" }: { apiUrl: string; workerId: string; runtimeHome: string; token: string; imageId?: string; bundlePath?: string }): string {
  if (!workerSettingsValid(apiUrl, workerId, runtimeHome, imageId, bundlePath) || !/^camp_worker_[A-Za-z0-9_-]+$/.test(token)) throw new Error("invalid_config");
  const settings = { CAMP_API_URL: new URL(apiUrl).href.replace(/\/+$/, ""), CAMP_WORKER_ID: workerId, CAMP_RUNTIME_HOME: runtimeHome, CAMP_WORKER_TOKEN: token, ...(imageId ? { CAMP_RUNTIME_IMAGE: imageId } : {}), ...(bundlePath ? { CAMP_TOOLCHAIN_BUNDLE: bundlePath } : {}) };
  return Object.entries(settings).map(([key, value]) => `${key}=${environmentValue(value)}\n`).join("");
}

export const WORKER_COMMANDS = {
  permissions: "chmod 600 .camp/worker.env",
  init: "node --env-file=.camp/worker.env packages/camp-runtime/scripts/worker-ops.mjs init",
  doctor: "node --env-file=.camp/runtime.env --env-file=.camp/worker.env packages/camp-runtime/scripts/doctor.mjs --report --require-agent",
  start: "node --env-file=.camp/runtime.env --env-file=.camp/worker.env --import @oxc-node/core/register packages/camp-runtime/src/worker.mjs",
  reap: "node --env-file=.camp/worker.env packages/camp-runtime/scripts/worker-ops.mjs reap",
  reapApply: "node --env-file=.camp/worker.env packages/camp-runtime/scripts/worker-ops.mjs reap --apply",
} as const;
