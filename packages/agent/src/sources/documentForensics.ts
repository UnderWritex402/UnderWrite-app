import { createHash } from "node:crypto";
import { ok, unavailable } from "../types.js";
import type {
  DocumentForensicsResult,
  DocumentMetadata,
  ForensicSignal,
  SourceResult,
  VerificationRequest,
} from "../types.js";

/**
 * Source 4 - invoice document forensics.
 *
 * Reads the PDF's own structure rather than its rendered content: the trailer,
 * the info dictionary, and the incremental-update markers. These are the parts
 * a forger has to get right *in addition to* making the page look correct, and
 * they are usually the parts left inconsistent.
 *
 * Nothing here proves fraud on its own. Each signal carries a severity and a
 * plain-language detail so the evidence report can show what was observed and
 * a human can disagree with it.
 */

/**
 * Default maximum document size (10 MiB) accepted by document forensics.
 * Documents larger than this limit are rejected before any string decoding.
 */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Maximum length of a single PDF literal info value inspected by `infoValues`. */
const MAX_INFO_VALUE_LENGTH = 512;

export interface DocumentForensicsOptions {
  /** Maximum allowed byte length of `request.document` (default: 10 MiB). */
  maxDocumentBytes?: number | undefined;
}

/**
 * Producers associated with editing an existing document rather than
 * generating one from an accounting system. Their presence on an invoice is
 * not damning - plenty of legitimate invoices are scanned - but it is worth
 * surfacing, at low severity.
 */
const EDITING_PRODUCERS = [
  "photoshop",
  "gimp",
  "illustrator",
  "inkscape",
  "pdfescape",
  "sejda",
  "ilovepdf",
  "smallpdf",
  "pdf24",
  "foxit phantom",
  "nitro pro",
];

/** Annotation subtypes that can be used to paste new values over old ones. */
const OVERLAY_ANNOTATION_SUBTYPES = ["FreeText", "Square", "Stamp", "Redact"];

/** Leading bytes identifying the common non-PDF formats sellers upload. */
const FILE_SIGNATURES: ReadonlyArray<{ type: string; bytes: number[] }> = [
  { type: "zip/ooxml", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { type: "ole/legacy-office", bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { type: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: "tiff", bytes: [0x49, 0x49, 0x2a, 0x00] },
];

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // "%PDF-"
const EOF_TOKEN = Buffer.from("%%EOF", "latin1");

function startsWithPdfMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

function countTokenBytes(buf: Buffer, token: Buffer): number {
  let count = 0;
  let offset = 0;
  while (offset <= buf.length - token.length) {
    const found = buf.indexOf(token, offset);
    if (found === -1) break;
    count += 1;
    offset = found + token.length;
  }
  return count;
}

export function analyzeDocument(
  request: VerificationRequest,
  options: DocumentForensicsOptions = {},
): SourceResult<DocumentForensicsResult> {
  try {
    const maxDocumentBytes = options.maxDocumentBytes ?? MAX_DOCUMENT_BYTES;
    if (!Number.isFinite(maxDocumentBytes) || maxDocumentBytes < 1) {
      return unavailable(
        "document forensics failed: maxDocumentBytes must be >= 1",
      );
    }

    const bytes = request.document;
    if (bytes.length === 0) {
      return unavailable("invoice document is empty");
    }

    if (bytes.length > maxDocumentBytes) {
      return unavailable(
        `invoice document size (${bytes.length} bytes) exceeds maximum allowed (${maxDocumentBytes} bytes)`,
      );
    }

    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const documentHash = createHash("sha256").update(buf).digest("hex");

    if (!startsWithPdfMagic(bytes)) {
      // A non-PDF document is not a failure of the source - the source ran, and
      // its answer is "this is not a PDF, so PDF checks say nothing about it".
      // Checked on raw header bytes before allocating any decoded text string.
      return ok({
        fileType: detectFileType(bytes),
        documentHash,
        signals: [
          {
            code: "missing_metadata",
            detail:
              "Document is not a PDF, so PDF structural and metadata checks could not be applied.",
            severity: 25,
          },
        ],
        metadata: emptyMetadata(),
      });
    }

    const metadata = extractMetadataFromBuffer(buf);
    const signals = collectSignalsFromBuffer(buf, metadata, request);

    return ok({ fileType: "pdf", documentHash, signals, metadata });
  } catch (error) {
    return unavailable(
      `document forensics failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function emptyMetadata(): DocumentMetadata {
  return {
    producer: null,
    creator: null,
    creationDate: null,
    modificationDate: null,
    eofMarkers: 0,
    pdfVersion: null,
  };
}

function detectFileType(bytes: Uint8Array): string {
  for (const { type, bytes: signature } of FILE_SIGNATURES) {
    if (signature.every((byte, index) => bytes[index] === byte)) {
      return type;
    }
  }
  return "unknown";
}

/**
 * Scans `buf` for `/Key (...)` entries using bounded index searches rather than
 * converting the entire PDF buffer into one large Latin-1 string.
 */
function infoValuesFromBuffer(buf: Buffer, key: string): string[] {
  const token = Buffer.from(`/${key}`, "latin1");
  const values: string[] = [];
  let offset = 0;

  while (offset <= buf.length - token.length) {
    const found = buf.indexOf(token, offset);
    if (found === -1) break;

    let cursor = found + token.length;
    while (cursor < buf.length) {
      const ch = buf[cursor];
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        cursor += 1;
      } else {
        break;
      }
    }

    if (cursor < buf.length && buf[cursor] === 0x28 /* '(' */) {
      const start = cursor + 1;
      const limit = Math.min(buf.length, start + MAX_INFO_VALUE_LENGTH);
      let end = start;
      let escaped = false;
      let closed = false;

      while (end < limit) {
        const b = buf[end];
        if (escaped) {
          escaped = false;
        } else if (b === 0x5c /* '\\' */) {
          escaped = true;
        } else if (b === 0x29 /* ')' */) {
          closed = true;
          break;
        }
        end += 1;
      }

      if (closed) {
        const raw = buf.subarray(start, end).toString("latin1").trim();
        if (raw !== "") {
          values.push(decodePdfString(raw));
        }
        offset = end + 1;
        continue;
      }
    }

    offset = found + token.length;
  }

  return values;
}

/** Handles the escape sequences a PDF literal string may contain. */
function decodePdfString(raw: string): string {
  const escapes: Record<string, string> = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
  };
  return raw.replace(/\\([nrtbf()\\])/g, (_, ch: string) => escapes[ch] ?? ch);
}

function extractMetadataFromBuffer(buf: Buffer): DocumentMetadata {
  const producers = infoValuesFromBuffer(buf, "Producer");
  const creators = infoValuesFromBuffer(buf, "Creator");
  const creationDates = infoValuesFromBuffer(buf, "CreationDate");
  const modDates = infoValuesFromBuffer(buf, "ModDate");
  const headerSlice = buf.subarray(0, Math.min(buf.length, 32)).toString("latin1");
  const versionMatch = /^%PDF-(\d+\.\d+)/.exec(headerSlice);

  return {
    // The last writer wins in a PDF with incremental updates, so the last
    // value is the one describing the file as it now stands.
    producer: producers.at(-1) ?? null,
    creator: creators.at(-1) ?? null,
    creationDate: parsePdfDate(creationDates.at(-1)),
    modificationDate: parsePdfDate(modDates.at(-1)),
    eofMarkers: countTokenBytes(buf, EOF_TOKEN),
    pdfVersion: versionMatch?.[1] ?? null,
  };
}

/** PDF dates look like `D:20260105143000+01'00'`. Returns ISO 8601 or null. */
export function parsePdfDate(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const match =
    /D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?)?/.exec(
      raw,
    );
  if (match === null) return null;

  const [, year, month, day, hour, minute, second, zulu, sign, tzHour, tzMinute] =
    match;
  if (year === undefined) return null;

  const offset =
    zulu !== undefined || sign === undefined
      ? "Z"
      : `${sign}${tzHour ?? "00"}:${tzMinute ?? "00"}`;

  const iso = `${year}-${month ?? "01"}-${day ?? "01"}T${hour ?? "00"}:${minute ?? "00"}:${second ?? "00"}${offset}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function hasEncryptToken(buf: Buffer): boolean {
  const token = Buffer.from("/Encrypt", "latin1");
  let offset = 0;
  while (offset <= buf.length - token.length) {
    const idx = buf.indexOf(token, offset);
    if (idx === -1) return false;
    const nextByte = buf[idx + token.length];
    const isWordBoundary =
      nextByte === undefined ||
      nextByte < 0x30 ||
      (nextByte > 0x39 && nextByte < 0x41) ||
      (nextByte > 0x5a && nextByte !== 0x5f && nextByte < 0x61) ||
      nextByte > 0x7a;
    if (isWordBoundary) return true;
    offset = idx + token.length;
  }
  return false;
}

function collectSignalsFromBuffer(
  buf: Buffer,
  metadata: DocumentMetadata,
  request: VerificationRequest,
): ForensicSignal[] {
  const signals: ForensicSignal[] = [];
  const producers = infoValuesFromBuffer(buf, "Producer");

  if (metadata.eofMarkers > 1) {
    signals.push({
      code: "incremental_update",
      detail: `Found ${metadata.eofMarkers} %%EOF markers: the file was saved, then appended to ${metadata.eofMarkers - 1} more time(s) after its original end.`,
      severity: 55,
    });
  }

  const uniqueProducers = [...new Set(producers)];
  if (uniqueProducers.length > 1) {
    signals.push({
      code: "multiple_producers",
      detail: `Document reports more than one producer across its revisions: ${uniqueProducers.join(" then ")}.`,
      severity: 60,
    });
  }

  if (metadata.producer === null && metadata.creator === null) {
    signals.push({
      code: "missing_metadata",
      detail:
        "Document carries neither a Producer nor a Creator. Metadata stripping is a normal privacy step, but it also removes the trail a forgery would leave.",
      severity: 30,
    });
  }

  if (metadata.creationDate !== null && metadata.modificationDate !== null) {
    const created = Date.parse(metadata.creationDate);
    const modified = Date.parse(metadata.modificationDate);
    // A second of slack: many generators stamp both fields from one clock read.
    if (modified - created > 1_000) {
      signals.push({
        code: "modified_after_creation",
        detail: `Document was modified ${describeGap(modified - created)} after it was created (created ${metadata.creationDate}, modified ${metadata.modificationDate}).`,
        severity: 45,
      });
    }
  }

  const editingProducer = matchEditingProducer(
    metadata.producer,
    metadata.creator,
  );
  if (editingProducer !== null) {
    signals.push({
      code: "producer_mismatch",
      detail: `Document was last written by "${editingProducer}", a tool for editing existing documents rather than generating an invoice from an accounting system.`,
      severity: 35,
    });
  }

  const overlays = OVERLAY_ANNOTATION_SUBTYPES.filter(
    (subtype) =>
      buf.indexOf(Buffer.from(`/Subtype /${subtype}`, "latin1")) !== -1 ||
      buf.indexOf(Buffer.from(`/Subtype/${subtype}`, "latin1")) !== -1,
  );
  if (overlays.length > 0) {
    signals.push({
      code: "annotation_overlay",
      detail: `Document contains ${overlays.join(", ")} annotation(s), which can render new values on top of the original page content.`,
      severity: 50,
    });
  }

  if (hasEncryptToken(buf)) {
    signals.push({
      code: "encrypted_document",
      detail:
        "Document is encrypted, so its content streams could not be inspected. Structural checks are limited to the trailer.",
      severity: 20,
    });
  }

  const invoiceDate = Date.parse(request.invoiceDate);
  if (metadata.creationDate !== null && !Number.isNaN(invoiceDate)) {
    const created = Date.parse(metadata.creationDate);
    // One day of slack absorbs the difference between the invoice's printed
    // local date and the file's UTC creation stamp.
    const daysAfter = (created - invoiceDate) / 86_400_000;
    if (daysAfter > 1) {
      signals.push({
        code: "creation_date_after_invoice_date",
        detail: `The PDF was created ${Math.floor(daysAfter)} day(s) after the invoice date it states (${request.invoiceDate}). Back-dating an invoice produces exactly this gap.`,
        severity: 40,
      });
    }
  }

  return signals;
}

function matchEditingProducer(
  producer: string | null,
  creator: string | null,
): string | null {
  for (const candidate of [producer, creator]) {
    if (candidate === null) continue;
    const lowered = candidate.toLowerCase();
    if (EDITING_PRODUCERS.some((tool) => lowered.includes(tool))) {
      return candidate;
    }
  }
  return null;
}

function describeGap(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} minute(s)`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour(s)`;
  return `${Math.floor(hours / 24)} day(s)`;
}
