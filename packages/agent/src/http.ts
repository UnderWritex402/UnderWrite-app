/**
 * A single place where outbound HTTP happens, so that every external call
 * gets a timeout, bounded retries, and an error type the callers can degrade
 * on instead of an unhandled rejection (SRD FR-6, coding standards).
 */

export class HttpError extends Error {
  readonly status: number | null;
  readonly body: string | null;

  constructor(message: string, status: number | null, body: string | null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  /** Per-attempt timeout. Total wall time is roughly attempts x this. */
  timeoutMs?: number;
  /** Total attempts including the first. Only idempotent calls should retry. */
  attempts?: number;
  fetchImpl?: typeof fetch;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Truncated so a provider dumping HTML at us cannot flood the report. */
function truncate(text: string, max = 512): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export async function requestJson<T>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 10_000,
    attempts = 3,
    fetchImpl = fetch,
  } = options;

  let lastError: HttpError = new HttpError("no attempt was made", null, null);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        lastError = new HttpError(
          `${method} ${url} failed with ${response.status}`,
          response.status,
          truncate(text),
        );
        if (!RETRYABLE_STATUS.has(response.status)) throw lastError;
      } else {
        return (await response.json()) as T;
      }
    } catch (error) {
      if (error instanceof HttpError) {
        lastError = error;
        if (error.status !== null && !RETRYABLE_STATUS.has(error.status)) {
          throw error;
        }
      } else if (error instanceof Error && error.name === "AbortError") {
        lastError = new HttpError(
          `${method} ${url} timed out after ${timeoutMs}ms`,
          null,
          null,
        );
      } else {
        lastError = new HttpError(
          `${method} ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
          null,
          null,
        );
      }
    } finally {
      clearTimeout(timer);
    }

    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
  }

  throw lastError;
}

/** Renders any thrown value into the one-line reason a report carries. */
export function describeFailure(error: unknown): string {
  if (error instanceof HttpError) {
    return error.status === null
      ? error.message
      : `${error.message}${error.body ? `: ${error.body}` : ""}`;
  }
  return error instanceof Error ? error.message : String(error);
}
