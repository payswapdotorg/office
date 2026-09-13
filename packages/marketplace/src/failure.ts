// Office marketplace — typed failure builders (OFF-027).
//
// The small shared factory layer for the marketplace's typed DomainError
// failures: one stable detail code + one dotted path per rejection family,
// mirroring the app-runtime dispatch's rejection discipline ('cross-tenant-
// scope' under the kernel's 'unauthorized' code, and so on). Package-internal
// (NOT re-exported from src/index.ts).
import { domainError, fail } from '@office/domain-kernel';
import type { DomainError, DomainErrorDetail, Result } from '@office/domain-kernel';
import type { ContractParseError } from '@office/contracts';
import type { AppManifest, ManifestReview } from '@office/app-sdk';

/** Build the typed marketplace failure (one stable detail code + path). */
export const mktFailure = (
  code: Parameters<typeof domainError>[0],
  message: string,
  detail: DomainErrorDetail,
): Result<never, DomainError> =>
  fail(domainError(code, message, [detail]));

/** The subject of an operation was not found (stable detail codes per kind). */
export const notFoundFailure = (subject: string, id: string): Result<never, DomainError> =>
  mktFailure('not-found', `${subject} '${id}' not found`, {
    code: `unknown-${subject}`,
    message: id,
    path: null,
  });

/**
 * The acting tenant cannot address a record owned by another tenant (A12).
 * Mirrors the app-runtime's cross-tenant rejection shape byte-for-byte:
 * kernel code 'unauthorized', detail code 'cross-tenant-scope', both tenant
 * ids carried in the detail message.
 */
export const crossTenantFailure = (
  actingTenant: string,
  recordTenant: string,
): Result<never, DomainError> =>
  mktFailure(
    'unauthorized',
    `acting tenant ${actingTenant} cannot access a record owned by tenant ${recordTenant}`,
    {
      code: 'cross-tenant-scope',
      message: `acting=${actingTenant} record=${recordTenant}`,
      path: 'tenant',
    },
  );

/** The actor is identified but the operation is not permitted. */
export const forbiddenFailure = (code: string, message: string): Result<never, DomainError> =>
  mktFailure('forbidden', message, { code, message, path: null });

/** A typed domain rule of the marketplace lifecycle was violated. */
export const invariantFailure = (code: string, message: string): Result<never, DomainError> =>
  mktFailure('invariant-violation', message, { code, message, path: null });

/**
 * Normalize a failed ManifestReview into the marketplace's DomainError
 * channel. The SDK's review is the union of the structural parse
 * (ContractParseError) and the cross-reference validation (DomainError):
 * a validation failure passes through verbatim; a parse failure is
 * normalized into an 'invariant-violation' (the kernel's validation_failed
 * taxonomy code) carrying the parse error's code and path, so the intake
 * rejection is typed and inspectable either way.
 */
export const manifestReviewFailure = (
  error: ContractParseError | DomainError,
): DomainError => {
  if ('kind' in error && error.kind === 'domain-error') return error;
  const parse = error as ContractParseError;
  const at = parse.path === '' ? '<root>' : parse.path;
  return domainError(
    'invariant-violation',
    `manifest review failed: ${parse.code} at '${at}' — expected ${parse.expected}, received ${parse.received}`,
    [
      {
        code: `manifest-${parse.code}`,
        message: parse.path === '' ? '<root>' : parse.path,
        path: parse.path === '' ? null : parse.path,
      },
    ],
  );
};

/** Unwrap a ManifestReview onto the engine's Result channel (total). */
export const manifestReviewToResult = (
  review: ManifestReview,
): Result<AppManifest, DomainError> => {
  if (review.ok) return { ok: true as const, value: review.value };
  return { ok: false as const, error: manifestReviewFailure(review.error) };
};
