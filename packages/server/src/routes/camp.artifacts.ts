import { Router } from "express";
import type { NextFunction, Request, Response, Router as RouterType } from "express";
import { CAMP_ARTIFACT_LIMITS, CampProtocolError } from "../../../camp-protocol/src/index.js";
import { CampError } from "../services/camp/types";
import { authorizeArtifactPart, discardPrivateArtifact, getPrivateArtifactPart, putPrivateArtifactPart, readPrivateArtifact, reservePrivateArtifact, sealPrivateArtifact } from "../services/camp/privateArtifacts";

/** Mounted after Camp bearer authentication. Native backups are never exposed
 * through attachment URLs, browser member credentials or model Run tokens. */
export const campArtifactWorkerRouter: RouterType = Router();
const uuid = (value: string) => {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new CampError(400, "invalid_artifact", "A private artifact requires an exact UUID");
  return value;
};
const index = (value: string) => {
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value)) throw new CampError(400, "invalid_artifact", "Invalid artifact part index");
  return Number(value);
};
function endpoint(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    void handler(req, res).catch(error => {
      if (error instanceof CampError || error instanceof CampProtocolError) { res.status(error.status).json({ code: error.code, error: error.message }); return; }
      next(error);
    });
  };
}
async function partBody(req: Request, expected: number) {
  if (req.headers["content-type"] !== "application/octet-stream" || req.headers["content-encoding"] || Number(req.headers["content-length"]) !== expected) throw new CampError(400, "artifact_part_mismatch", "Supply the exact unencoded binary part length");
  const chunks: Buffer[] = []; let bytes = 0;
  const timer = setTimeout(() => req.destroy(), 60_000);
  try {
    for await (const value of req) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > expected || bytes > CAMP_ARTIFACT_LIMITS.partBytes) throw new CampError(413, "artifact_part_limit", "Artifact part exceeds its byte budget");
      chunks.push(chunk);
    }
    if (bytes !== expected) throw new CampError(400, "artifact_part_mismatch", "Artifact upload ended before its declared length");
    return Buffer.concat(chunks, bytes);
  } finally { clearTimeout(timer); }
}
campArtifactWorkerRouter.post("/storage-operations/:operationId/artifact", endpoint(async (req, res) => {
  res.status(201).json(await reservePrivateArtifact(res.locals.campPrincipal, uuid(req.params.operationId as string), req.body));
}));
campArtifactWorkerRouter.get("/storage-operations/:operationId/artifact", endpoint(async (req, res) => {
  res.json(await readPrivateArtifact(res.locals.campPrincipal, uuid(req.params.operationId as string)));
}));
campArtifactWorkerRouter.delete("/storage-operations/:operationId/artifacts/:artifactId", endpoint(async (req, res) => {
  res.json(await discardPrivateArtifact(res.locals.campPrincipal, uuid(req.params.operationId as string), uuid(req.params.artifactId as string)));
}));
campArtifactWorkerRouter.put("/storage-operations/:operationId/artifacts/:artifactId/parts/:partIndex", endpoint(async (req, res) => {
  const operationId = uuid(req.params.operationId as string), artifactId = uuid(req.params.artifactId as string), partIndex = index(req.params.partIndex as string);
  const { part } = await authorizeArtifactPart(res.locals.campPrincipal, operationId, artifactId, partIndex);
  res.json(await putPrivateArtifactPart(res.locals.campPrincipal, operationId, artifactId, partIndex, await partBody(req, part.bytes)));
}));
campArtifactWorkerRouter.post("/storage-operations/:operationId/artifacts/:artifactId/seal", endpoint(async (req, res) => {
  res.json(await sealPrivateArtifact(res.locals.campPrincipal, uuid(req.params.operationId as string), uuid(req.params.artifactId as string)));
}));
campArtifactWorkerRouter.get("/storage-operations/:operationId/artifacts/:artifactId/parts/:partIndex", endpoint(async (req, res) => {
  const bytes = await getPrivateArtifactPart(res.locals.campPrincipal, uuid(req.params.operationId as string), uuid(req.params.artifactId as string), index(req.params.partIndex as string));
  res.type("application/octet-stream").setHeader("Content-Length", bytes.length);
  res.send(bytes);
}));
