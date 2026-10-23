import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CAMP_ARTIFACT_LIMITS } from "../../../../camp-protocol/src/index.js";
import { CampError } from "./types";

/** This directory is deliberately independent of attachment/CDN backends.
 * Keys never leave the server. Future remote backends must preserve the same
 * publish-after-sync and bounded-read contract. */
export class PrivateArtifactStore {
  constructor(readonly directory: string) {}
  async ready() {
    if (!isAbsolute(this.directory)) throw new CampError(503, "artifact_storage_unavailable", "Private artifact storage requires an absolute directory");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || await realpath(this.directory) !== this.directory) throw new CampError(503, "artifact_storage_unavailable", "Private artifact storage requires a private owned canonical directory");
    return this;
  }
  private path(key: string) {
    if (!/^[a-f0-9-]{36}$/.test(key)) throw new CampError(500, "artifact_storage_key", "Invalid private artifact object identity");
    return join(this.directory, key);
  }
  async put(bytes: Buffer) {
    if (!bytes.length || bytes.length > CAMP_ARTIFACT_LIMITS.partBytes) throw new CampError(413, "artifact_part_limit", "Artifact part exceeds its byte budget");
    await this.ready();
    const key = randomUUID(), working = this.path(key) + ".partial";
    const file = await open(working, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(working, this.path(key));
    const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); }
    return key;
  }
  async get(key: string, expectedBytes: number) {
    await this.ready();
    const file = await open(this.path(key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== expectedBytes || stat.size > CAMP_ARTIFACT_LIMITS.partBytes || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new CampError(409, "artifact_corrupt", "Private artifact part size or ownership differs");
      return await file.readFile();
    } finally { await file.close(); }
  }
  async remove(key: string) { await rm(this.path(key), { force: true }); }
}

export function privateArtifactStore() {
  const directory = process.env.CAMP_PRIVATE_ARTIFACT_DIR;
  if (!directory) throw new CampError(503, "artifact_storage_unavailable", "Configure private Camp artifact storage before using transport");
  return new PrivateArtifactStore(directory);
}
