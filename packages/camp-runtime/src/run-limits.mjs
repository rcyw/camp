export class RunLimitError extends Error {
  constructor(message) { super(message); this.name = 'RunLimitError'; this.code = 'run_budget_exhausted'; }
}
export function runLimits(env = process.env) {
  const positive = (name, fallback) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  return {
    runTimeoutMs: positive('CAMP_RUN_TIMEOUT_MS', 900_000),
    maxRequests: positive('CAMP_MODEL_MAX_REQUESTS', 64),
    requestTimeoutMs: positive('CAMP_MODEL_REQUEST_TIMEOUT_MS', 180_000),
    maxRequestBytes: positive('CAMP_MODEL_MAX_REQUEST_BYTES', 8 * 1024 * 1024),
    maxInputBytes: positive('CAMP_MODEL_MAX_INPUT_BYTES', 64 * 1024 * 1024),
    maxResponseBytes: positive('CAMP_MODEL_MAX_RESPONSE_BYTES', 64 * 1024 * 1024),
  };
}

export class ModelBudget {
  constructor(limits = runLimits()) { this.limits = limits; this.requests = 0; this.inputBytes = 0; this.responseBytes = 0; }
  reserve(bytes) {
    if (bytes > this.limits.maxRequestBytes) throw new RunLimitError('Model request body exceeds its byte budget');
    if (this.requests + 1 > this.limits.maxRequests) throw new RunLimitError('Model request count budget exhausted');
    if (this.inputBytes + bytes > this.limits.maxInputBytes) throw new RunLimitError('Model input byte budget exhausted');
    this.requests++;
    this.inputBytes += bytes;
    return this.snapshot();
  }
  response(bytes) {
    this.responseBytes += bytes;
    if (this.responseBytes > this.limits.maxResponseBytes) throw new RunLimitError('Model response byte budget exhausted');
  }
  snapshot() { return { requests: this.requests, inputBytes: this.inputBytes, responseBytes: this.responseBytes }; }
}
