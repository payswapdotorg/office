// Office browser host — typed JSON response helpers (OFF-DEPLOY).
//
// The API routes are THIN by design: parse the typed request, call the
// gateway, return the typed Result as JSON. This module owns the shared
// response semantics so every route answers alike:
// - 200    the typed success value (health adds its own 200/503 split)
// - 400    an invalid request envelope (malformed JSON, an unknown command
//          discriminator, a missing approval object, or a fail-closed
//          HostInputRejection from the gateway's own parsers)
// - 403    the typed unauthorized domain rejection (A12: cross-project scope)
// - 404    the typed not-found domain rejection (A12: foreign tenant — no
//          existence oracle)
// - 422    any other typed domain rejection (the body IS the DomainError)
// - 503    an operational failure (the runtime could not boot, or the
//          database was unreachable mid-flight) — never a thrown error
import type { HostInputRejection } from '@office/host-gateway';

/** The typed rejection body shared by the domain-error shapes ({ code, message }). */
export interface TypedRejectionBody {
  readonly code: string;
  readonly message: string;
}

/** Map a typed rejection code onto its 4xx status (never a 5xx, never a throw). */
export const rejectionStatusOf = (code: string): number => {
  if (code === 'invalid-request') return 400;
  if (code === 'not-found') return 404;
  if (code === 'unauthorized') return 403;
  return 422;
};

/** Serialize one typed rejection with its 4xx status. */
export const rejectionResponse = (rejection: TypedRejectionBody): Response =>
  Response.json(rejection, { status: rejectionStatusOf(rejection.code) });

/** The catch-all of an operational failure (boot failure, database outage). */
export const operationalFailureResponse = (cause: unknown): Response =>
  Response.json(
    {
      kind: 'host-operational-failure',
      code: 'route-operational-failure',
      message: String(cause),
    },
    { status: 503 },
  );

/** Read the request body as untrusted JSON (fail-closed: never a throw). */
export const readJsonBody = async (
  request: Request,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: HostInputRejection }
> => {
  try {
    const text = await request.text();
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      error: {
        code: 'invalid-request',
        message: 'the request body is not valid JSON',
        details: [],
      },
    };
  }
};

/** The plain-object guard the route discriminators parse with. */
export const isRecord = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);
