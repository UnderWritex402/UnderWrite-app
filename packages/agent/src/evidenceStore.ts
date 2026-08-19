import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalize } from "./attestation.js";
import type { EvidenceReport } from "./types.js";

/**
 * Off-chain storage for full evidence reports (FR-9, NFR-6).
 *
 * Only the keccak256 hash of a report goes on-chain; the report itself lives
 * here and is addressed by that hash. Anyone holding the report can recompute
 * the hash and check it against the attestation, which is what makes the
 * on-chain number checkable rather than merely asserted.
 *
 * Reports are stored in their canonical serialisation — the exact bytes that
 * were hashed. Storing prettified JSON instead would mean the stored file and
 * the hashed content differ, and a verifier reading the file back would
 * compute a different hash and conclude the attestation was wrong.
 */

export interface EvidenceStore {
  /** Persists a report and returns the hash it is addressed by. */
  put(report: EvidenceReport): Promise<string>;
  /** Retrieves a report by its evidence hash, or null if absent. */
  get(evidenceHash: string): Promise<EvidenceReport | null>;
}

export class EvidenceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceStoreError";
  }
}

function assertHash(evidenceHash: string): void {
  // The hash becomes part of a filesystem path, so it is validated rather
  // than trusted: a caller-supplied "../../etc/passwd" must not resolve.
  if (!/^0x[0-9a-f]{64}$/.test(evidenceHash)) {
    throw new EvidenceStoreError(
      `"${evidenceHash}" is not a lowercase 0x-prefixed keccak256 hash`,
    );
  }
}

/**
 * Filesystem-backed store, suitable for a single-node testnet deployment.
 *
 * Reports are sharded by the first two hex characters of the hash so a
 * directory does not accumulate an unbounded number of entries.
 */
export class FileEvidenceStore implements EvidenceStore {
  private readonly root: string;

  constructor(directory: string) {
    this.root = resolve(directory);
  }

  private pathFor(evidenceHash: string): string {
    assertHash(evidenceHash);
    const body = evidenceHash.slice(2);
    return join(this.root, body.slice(0, 2), `${body}.json`);
  }

  async put(report: EvidenceReport): Promise<string> {
    const path = this.pathFor(report.evidenceHash);
    await mkdir(dirname(path), { recursive: true });
    // Canonical bytes, not prettified: see the note at the top of the file.
    await writeFile(path, canonicalize(report), "utf8");
    return report.evidenceHash;
  }

  async get(evidenceHash: string): Promise<EvidenceReport | null> {
    const path = this.pathFor(evidenceHash);
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as EvidenceReport;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      throw error;
    }
  }
}

/** In-memory store for tests and dry runs. Nothing survives a restart. */
export class MemoryEvidenceStore implements EvidenceStore {
  private readonly reports = new Map<string, EvidenceReport>();

  async put(report: EvidenceReport): Promise<string> {
    assertHash(report.evidenceHash);
    this.reports.set(report.evidenceHash, report);
    return report.evidenceHash;
  }

  async get(evidenceHash: string): Promise<EvidenceReport | null> {
    return this.reports.get(evidenceHash) ?? null;
  }
}
