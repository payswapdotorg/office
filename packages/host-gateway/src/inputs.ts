// Office host gateway — the fail-closed request-input parsers (OFF-DEPLOY).
//
// Every input that crosses the gateway's public surface (the host's API
// routes, tests, future transports) arrives as UNTRUSTED JSON. This module
// parses each request shape fail-closed: strict keys, typed fields, no
// silent defaults on presence, no throw — a malformed request is a typed
// rejection the route layer serializes (a 4xx with the typed rejection
// body, never a server error). The parsed inputs feed @office/web's own
// typed command bindings and the canonical domain command services, whose
// payload grammars are re-validated by the LANDED parsers downstream
// (defense in depth: the gateway validates the request envelope, the landed
// surfaces validate their own payloads).
import type {
  AdvanceWorkflowInput,
  ApproveWorkflowApprovalInput,
  CaptureFieldObservationInput,
  RecordCostItemInput,
  SubmitWorkflowApprovalInput,
} from '@office/web';
import { parseCorrelationId, parseIdempotencyKey } from '@office/contracts';

/** One typed rejection of an untrusted request input (displayable, strict). */
export interface HostInputRejection {
  readonly code: 'invalid-request';
  readonly message: string;
  readonly details: readonly { readonly code: string; readonly message: string; readonly path: string | null }[];
}

const reject = (path: string, message: string): HostInputRejection => ({
  code: 'invalid-request',
  message: `invalid request at '${path}': ${message}`,
  details: [{ code: 'invalid-field', message, path }],
});

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: HostInputRejection };

const isPlainObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw);

const requireString = (raw: Record<string, unknown>, key: string): Parsed<string> => {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: reject(key, `expected a non-empty string, received ${typeof value}`) };
  }
  return { ok: true, value };
};

const optionalString = (raw: Record<string, unknown>, key: string): Parsed<string | undefined> => {
  const value = raw[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string') {
    return { ok: false, error: reject(key, `expected a string when present, received ${typeof value}`) };
  }
  return { ok: true, value };
};

/** An optional idempotency key, branded through the landed grammar (A8/ADR-005). */
const optionalIdempotencyKey = (raw: Record<string, unknown>, key: string): Parsed<string | undefined> => {
  const value = raw[key];
  if (value === undefined) return { ok: true, value: undefined };
  const parsed = parseIdempotencyKey(value);
  if (!parsed.ok) {
    return {
      ok: false,
      error: reject(key, `expected an idempotency key (opaque printable ASCII, 8..128 characters), received '${String(value)}'`),
    };
  }
  return { ok: true, value: parsed.value };
};

/** An optional correlation id, branded through the landed grammar. */
const optionalCorrelationId = (raw: Record<string, unknown>, key: string): Parsed<string | undefined> => {
  const value = raw[key];
  if (value === undefined) return { ok: true, value: undefined };
  const parsed = parseCorrelationId(value);
  if (!parsed.ok) {
    return {
      ok: false,
      error: reject(key, `expected a correlation id (opaque printable ASCII, 8..128 characters), received '${String(value)}'`),
    };
  }
  return { ok: true, value: parsed.value };
};

const requireNumber = (raw: Record<string, unknown>, key: string): Parsed<number> => {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return {
      ok: false,
      error: reject(key, `expected a non-negative integer, received ${String(typeof value === 'number' ? value : typeof value)}`),
    };
  }
  return { ok: true, value };
};

const requireObject = (raw: Record<string, unknown>, key: string): Parsed<Record<string, unknown>> => {
  const value = raw[key];
  if (!isPlainObject(value)) {
    return { ok: false, error: reject(key, `expected an object, received ${Array.isArray(value) ? 'array' : typeof value}`) };
  }
  return { ok: true, value };
};

/** The untrusted field-capture request: the shell's offline-style capture. */
export const parseCaptureFieldObservationRequest = (raw: unknown): Parsed<CaptureFieldObservationInput> => {
  if (!isPlainObject(raw)) return { ok: false, error: reject('', `expected an object, received ${typeof raw}`) };
  const category = requireString(raw, 'category');
  if (!category.ok) return category;
  const summary = requireString(raw, 'summary');
  if (!summary.ok) return summary;
  const detail = optionalString(raw, 'detail');
  if (!detail.ok) return detail;
  const location = requireString(raw, 'location');
  if (!location.ok) return location;
  const observedAt = requireString(raw, 'observedAt');
  if (!observedAt.ok) return observedAt;
  const observedBy = requireString(raw, 'observedBy');
  if (!observedBy.ok) return observedBy;
  const quantityRaw = raw['quantity'];
  let quantity: CaptureFieldObservationInput['quantity'] | undefined;
  if (quantityRaw !== undefined) {
    if (!isPlainObject(quantityRaw)) {
      return { ok: false, error: reject('quantity', `expected an object when present, received ${typeof quantityRaw}`) };
    }
    const value = requireNumber(quantityRaw, 'quantity.value');
    if (!value.ok) return value;
    const unit = requireString(quantityRaw, 'unit');
    if (!unit.ok) return unit;
    quantity = { value: value.value, unit: unit.value };
  }
  return {
    ok: true,
    value: {
      category: category.value,
      summary: summary.value,
      ...(detail.value !== undefined ? { detail: detail.value } : {}),
      location: location.value,
      observedAt: observedAt.value,
      observedBy: observedBy.value,
      ...(quantity !== undefined ? { quantity } : {}),
    },
  };
};

/** The untrusted cost-record request: the budget-side response binding. */
export const parseRecordCostItemRequest = (raw: unknown): Parsed<RecordCostItemInput> => {
  if (!isPlainObject(raw)) return { ok: false, error: reject('', `expected an object, received ${typeof raw}`) };
  const budgetId = requireString(raw, 'budgetId');
  if (!budgetId.ok) return budgetId;
  const expectedVersion = requireNumber(raw, 'expectedVersion');
  if (!expectedVersion.ok) return expectedVersion;
  const code = requireString(raw, 'code');
  if (!code.ok) return code;
  const description = requireString(raw, 'description');
  if (!description.ok) return description;
  const unit = requireString(raw, 'unit');
  if (!unit.ok) return unit;
  const quantityMilli = requireNumber(raw, 'quantityMilli');
  if (!quantityMilli.ok) return quantityMilli;
  const unitRateMinor = requireNumber(raw, 'unitRateMinor');
  if (!unitRateMinor.ok) return unitRateMinor;
  return {
    ok: true,
    value: {
      budgetId: budgetId.value,
      expectedVersion: expectedVersion.value,
      code: code.value,
      description: description.value,
      unit: unit.value,
      quantityMilli: quantityMilli.value,
      unitRateMinor: unitRateMinor.value,
    },
  };
};

/** The untrusted workflow-approval submission request. */
export const parseSubmitWorkflowApprovalRequest = (raw: unknown): Parsed<SubmitWorkflowApprovalInput> => {
  if (!isPlainObject(raw)) return { ok: false, error: reject('', `expected an object, received ${typeof raw}`) };
  const instanceId = requireString(raw, 'instanceId');
  if (!instanceId.ok) return instanceId;
  const expectedVersion = requireNumber(raw, 'expectedVersion');
  if (!expectedVersion.ok) return expectedVersion;
  const approvalKey = requireString(raw, 'approvalKey');
  if (!approvalKey.ok) return approvalKey;
  return {
    ok: true,
    value: { instanceId: instanceId.value, expectedVersion: expectedVersion.value, approvalKey: approvalKey.value },
  };
};

/** The untrusted workflow-approval decision request (the approval binding). */
export const parseApproveWorkflowApprovalRequest = (raw: unknown): Parsed<ApproveWorkflowApprovalInput> => {
  if (!isPlainObject(raw)) return { ok: false, error: reject('', `expected an object, received ${typeof raw}`) };
  const instanceId = requireString(raw, 'instanceId');
  if (!instanceId.ok) return instanceId;
  const expectedVersion = requireNumber(raw, 'expectedVersion');
  if (!expectedVersion.ok) return expectedVersion;
  const approvalKey = requireString(raw, 'approvalKey');
  if (!approvalKey.ok) return approvalKey;
  const note = optionalString(raw, 'note');
  if (!note.ok) return note;
  return {
    ok: true,
    value: {
      instanceId: instanceId.value,
      expectedVersion: expectedVersion.value,
      approvalKey: approvalKey.value,
      ...(note.value !== undefined ? { note: note.value } : {}),
    },
  };
};

/** The untrusted workflow-transition request (one guarded machine step). */
export const parseAdvanceWorkflowRequest = (raw: unknown): Parsed<AdvanceWorkflowInput> => {
  if (!isPlainObject(raw)) return { ok: false, error: reject('', `expected an object, received ${typeof raw}`) };
  const instanceId = requireString(raw, 'instanceId');
  if (!instanceId.ok) return instanceId;
  const expectedVersion = requireNumber(raw, 'expectedVersion');
  if (!expectedVersion.ok) return expectedVersion;
  const transitionKey = requireString(raw, 'transitionKey');
  if (!transitionKey.ok) return transitionKey;
  return {
    ok: true,
    value: {
      instanceId: instanceId.value,
      expectedVersion: expectedVersion.value,
      transitionKey: transitionKey.value,
    },
  };
};

/** The untrusted canonical project-update request (the REAL PG command path). */
export interface UpdateProjectRequest {
  readonly projectId: string;
  readonly expectedVersion: number;
  readonly name?: string;
  readonly extensionMetadata?: Record<string, unknown>;
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
}

/** Parse the canonical project-update request (at least one change required). */
export const parseUpdateProjectRequest = (raw: unknown): Parsed<UpdateProjectRequest> => {
  if (!isPlainObject(raw)) return { ok: false, error: reject('', `expected an object, received ${typeof raw}`) };
  const projectId = requireString(raw, 'projectId');
  if (!projectId.ok) return projectId;
  const expectedVersion = requireNumber(raw, 'expectedVersion');
  if (!expectedVersion.ok) return expectedVersion;
  const name = optionalString(raw, 'name');
  if (!name.ok) return name;
  const metadataRaw = raw['extensionMetadata'];
  let extensionMetadata: Record<string, unknown> | undefined;
  if (metadataRaw !== undefined) {
    const metadata = requireObject(raw, 'extensionMetadata');
    if (!metadata.ok) return metadata;
    extensionMetadata = metadata.value;
  }
  if (name.value === undefined && extensionMetadata === undefined) {
    return { ok: false, error: reject('', 'at least one of name or extensionMetadata is required') };
  }
  const idempotencyKey = optionalIdempotencyKey(raw, 'idempotencyKey');
  if (!idempotencyKey.ok) return idempotencyKey;
  const correlationId = optionalCorrelationId(raw, 'correlationId');
  if (!correlationId.ok) return correlationId;
  return {
    ok: true,
    value: {
      projectId: projectId.value,
      expectedVersion: expectedVersion.value,
      ...(name.value !== undefined ? { name: name.value } : {}),
      ...(extensionMetadata !== undefined ? { extensionMetadata } : {}),
      ...(idempotencyKey.value !== undefined ? { idempotencyKey: idempotencyKey.value } : {}),
      ...(correlationId.value !== undefined ? { correlationId: correlationId.value } : {}),
    },
  };
};

/** The untrusted approval-decision action request (the A8 approval-gated action). */
export interface ApprovalDecisionRequest {
  readonly instanceId: string;
  readonly expectedVersion: number;
  readonly approvalKey: string;
  readonly note?: string;
  /** The A4 evidence reference filling the descriptor's 'approval-basis' slot. */
  readonly basis: string;
  /** Client-issued idempotency key (A8/ADR-005); derived deterministically when absent. */
  readonly idempotencyKey?: string;
}

/** Parse the approval-decision action request (the evidence basis is required). */
export const parseApprovalDecisionRequest = (raw: unknown): Parsed<ApprovalDecisionRequest> => {
  if (!isPlainObject(raw)) return { ok: false, error: reject('', `expected an object, received ${typeof raw}`) };
  const instanceId = requireString(raw, 'instanceId');
  if (!instanceId.ok) return instanceId;
  const expectedVersion = requireNumber(raw, 'expectedVersion');
  if (!expectedVersion.ok) return expectedVersion;
  const approvalKey = requireString(raw, 'approvalKey');
  if (!approvalKey.ok) return approvalKey;
  const note = optionalString(raw, 'note');
  if (!note.ok) return note;
  const basis = requireString(raw, 'basis');
  if (!basis.ok) return basis;
  const idempotencyKey = optionalIdempotencyKey(raw, 'idempotencyKey');
  if (!idempotencyKey.ok) return idempotencyKey;
  return {
    ok: true,
    value: {
      instanceId: instanceId.value,
      expectedVersion: expectedVersion.value,
      approvalKey: approvalKey.value,
      ...(note.value !== undefined ? { note: note.value } : {}),
      basis: basis.value,
      ...(idempotencyKey.value !== undefined ? { idempotencyKey: idempotencyKey.value } : {}),
    },
  };
};
