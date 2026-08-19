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

export function analyzeDocument(
  request: VerificationRequest,
): SourceResult<DocumentForensicsResult> {
  try {
    const bytes = request.document;
    if (bytes.length === 0) {
      return unavailable("invoice document is empty");
    }

    const documentHash = createHash("sha256").update(bytes).digest("hex");

    // PDF is byte-oriented and mostly ASCII in its structural parts. Latin-1
    // preserves byte values one-to-one, so offsets found here are real offsets.
    const text = Buffer.from(bytes).toString("latin1");

    if (!text.startsWith("%PDF-")) {
      // A non-PDF document is not a failure of the source - the source ran, and
      // its answer is "this is not a PDF, so PDF checks say nothing about it".
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

    const metadata = extractMetadata(text);
    const signals = collectSignals(text, metadata, request);

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

/** All values for a given PDF info key, in document order. */
function infoValues(text: string, key: string): string[] {
  const pattern = new RegExp(`/${key}\\s*\\(([^)]*)\\)`, "g");
  const values: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[1];
    if (value !== undefined && value.trim() !== "") {
      values.push(decodePdfString(value.trim()));
    }
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

function extractMetadata(text: string): DocumentMetadata {
  const producers = infoValues(text, "Producer");
  const creators = infoValues(text, "Creator");
  const creationDates = infoValues(text, "CreationDate");
  const modDates = infoValues(text, "ModDate");
  const versionMatch = /^%PDF-(\d+\.\d+)/.exec(text);

  return {
    // The last writer wins in a PDF with incremental updates, so the last
    // value is the one describing the file as it now stands.
    producer: producers.at(-1) ?? null,
    creator: creators.at(-1) ?? null,
    creationDate: parsePdfDate(creationDates.at(-1)),
    modificationDate: parsePdfDate(modDates.at(-1)),
    eofMarkers: (text.match(/%%EOF/g) ?? []).length,
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

function collectSignals(
  text: string,
  metadata: DocumentMetadata,
  request: VerificationRequest,
): ForensicSignal[] {
  const signals: ForensicSignal[] = [];
  const producers = infoValues(text, "Producer");

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
      text.includes(`/Subtype /${subtype}`) ||
      text.includes(`/Subtype/${subtype}`),
  );
  if (overlays.length > 0) {
    signals.push({
      code: "annotation_overlay",
      detail: `Document contains ${overlays.join(", ")} annotation(s), which can render new values on top of the original page content.`,
      severity: 50,
    });
  }

  if (/\/Encrypt\b/.test(text)) {
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
