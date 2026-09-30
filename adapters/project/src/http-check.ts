import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { URL } from "node:url";

/**
 * The one HTTP client in this framework, and the smallest one that can answer a runtime question.
 *
 * A runtime check is "this request produces this response". Anything beyond that is a different
 * capability with a different cost: a browser, a screenshot, a DOM, a JavaScript runtime, a
 * cookie jar, a redirect policy, a retry policy. None of them is here, and the reason is not
 * caution about them but that each one makes the *result* harder to read. A failing check here says
 * `GET / returned 500, expected 200`, which is the whole finding. A failing browser check says a
 * selector timed out, which is a second investigation.
 *
 * What that costs is stated rather than hidden. Only `http:` is supported, because a runtime
 * verification starts a process on this machine and that process serves plain HTTP; there is no TLS
 * to trust and no certificate to manage. Redirects are not followed, so a `302` is a `302` and a
 * check expecting `200` fails on the redirect rather than quietly reporting the destination. The
 * response body is read only up to a fixed ceiling, and the rest is drained rather than buffered, so
 * a server that streams forever cannot hold this process's memory.
 *
 * Like the process runner, this never throws: a refused connection, a reset, a timeout, and a
 * cancelled request are all results, because each of them is the answer to "does it work".
 */
export const MAX_RUNTIME_RESPONSE_BYTES = 256 * 1024;

/** Stable reasons a request did not produce a response. */
export const HTTP_REQUEST_FAILURES = [
  "connection_refused",
  "connection_reset",
  "request_timeout",
  "request_aborted",
  "request_failed",
] as const;

export type HttpRequestFailure = (typeof HTTP_REQUEST_FAILURES)[number];

export interface HttpCheckRequest {
  /** An absolute `http:` URL. */
  readonly url: string;
  readonly method: string;
  /** A per-request deadline. A request that overruns is reported, never waited on. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | null;
  /** Bytes of the response body to read. The remainder is drained and counted. */
  readonly maxResponseBytes?: number;
}

export interface HttpCheckOutcome {
  /** True only when a complete response with a status was received. */
  readonly responded: boolean;
  readonly status: number | null;
  /** Bytes of the body the server sent, which may be more than were kept. */
  readonly bodyBytes: number;
  readonly bodyExcerpt: string;
  readonly truncated: boolean;
  readonly failure: HttpRequestFailure | null;
  readonly durationMs: number;
}

interface ResolvedTarget {
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
}

/**
 * Splits a URL into the parts a request needs, refusing anything this client does not do.
 *
 * The refusal is at the call site rather than in the middle of a request, so a `https:` URL is
 * reported as unsupported before a socket is opened instead of failing later as a connection error
 * that says nothing about why.
 */
export function resolveHttpTarget(url: string): ResolvedTarget {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`The URL "${url}" could not be parsed.`);
  }

  if (parsed.protocol !== "http:") {
    throw new TypeError(
      `The URL "${url}" uses "${parsed.protocol}", and this client only speaks "http:". Runtime verification starts a process on this machine and probes it there; a scheme it cannot speak is refused rather than attempted.`,
    );
  }

  return {
    hostname: parsed.hostname,
    port: parsed.port === "" ? 80 : Number.parseInt(parsed.port, 10),
    // The query and fragment are part of what was asked for, and both belong in the request line.
    path: `${parsed.pathname}${parsed.search}`,
  };
}

function classify(error: NodeJS.ErrnoException): HttpRequestFailure {
  switch (error.code) {
    case "ECONNREFUSED":
      return "connection_refused";
    case "ECONNRESET":
    case "EPIPE":
      return "connection_reset";
    case "ETIMEDOUT":
      return "request_timeout";
    case "ABORT_ERR":
      return "request_aborted";
    default:
      return "request_failed";
  }
}

/**
 * Performs one request and reports exactly what came back.
 *
 * The connection is not pooled and `Connection: close` is sent, so a checked server has no lingering
 * socket from this framework after the check is over. A check that timed out or was cancelled destroys
 * the request rather than leaving it to finish on its own schedule, which is what keeps a readiness
 * poll from piling up connections against a server that is still booting.
 */
export function performHttpCheck(request: HttpCheckRequest): Promise<HttpCheckOutcome> {
  const target = resolveHttpTarget(request.url);
  const ceiling = request.maxResponseBytes ?? MAX_RUNTIME_RESPONSE_BYTES;
  const startedAt = Date.now();

  return new Promise<HttpCheckOutcome>((resolve) => {
    let settled = false;
    let bodyBytes = 0;
    let kept = "";
    let truncated = false;
    let failure: HttpRequestFailure | null = null;

    const settle = (status: number | null): void => {
      if (settled) {
        return;
      }

      settled = true;
      request.signal?.removeEventListener("abort", onAbort);
      resolve({
        responded: failure === null && status !== null,
        status,
        bodyBytes,
        bodyExcerpt: kept,
        truncated,
        failure,
        durationMs: Date.now() - startedAt,
      });
    };

    const onAbort = (): void => {
      failure = "request_aborted";
      child.destroy();
    };

    const child: ClientRequest = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        method: request.method,
        headers: { connection: "close", accept: "*/*" },
        // No keep-alive pool: the whole point is to leave nothing behind on a server under test.
        agent: false,
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? null;

        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          bodyBytes += Buffer.byteLength(chunk, "utf8");

          if (kept.length < ceiling) {
            kept += chunk.slice(0, Math.max(0, ceiling - kept.length));
          }

          if (bodyBytes > ceiling) {
            // The rest is counted rather than kept, and the stream is drained so the socket closes
            // instead of being left half-read for the server to wait on.
            truncated = true;
          }
        });
        response.on("end", () => {
          settle(status);
        });
        response.on("error", (error: NodeJS.ErrnoException) => {
          // The first failure is the one that counts. A deadline fires `request_timeout` and then
          // destroys the request, which surfaces here as a reset; reporting the reset would name the
          // consequence and lose the cause.
          if (failure === null) {
            failure = classify(error);
          }

          settle(status);
        });
      },
    );

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (failure === null) {
        failure = classify(error);
      }

      settle(null);
    });

    child.setTimeout(request.timeoutMs, () => {
      failure = "request_timeout";
      child.destroy();
    });

    request.signal?.addEventListener("abort", onAbort, { once: true });

    if (request.signal?.aborted === true) {
      onAbort();
      return;
    }

    child.end();
  });
}
