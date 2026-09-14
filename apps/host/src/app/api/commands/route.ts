// Office browser host — /api/commands (OFF-DEPLOY).
//
// POST forwards ONE typed command request to the gateway's own command
// bindings. The body is the envelope `{ command, request }`: `command` is
// the discriminator naming one of the gateway's five bindings
// (captureFieldObservation, recordCostItem, submitWorkflowApproval,
// approveWorkflowApproval, advanceWorkflowInstance) and `request` is that
// binding's untrusted input, parsed FAIL-CLOSED inside the gateway (strict
// keys, typed HostInputRejection values, never a throw — defense in depth:
// this route only validates the envelope).
//
// Response semantics: 200 with the typed CommandOutcomeView when the command
// executed or replayed; 422 with the SAME view when the command's own typed
// outcome is 'rejected' (the shell's contract: rejections are displayable
// view models, never thrown errors); 400 for a malformed envelope, malformed
// JSON, or the gateway's fail-closed input rejection; 503 for an
// operational failure.
import { getHostRuntime } from '../../../server/runtime';
import {
  isRecord,
  operationalFailureResponse,
  readJsonBody,
} from '../../../server/http';
import type { HostInputRejection, HostRuntime } from '@office/host-gateway';

export const dynamic = 'force-dynamic';

/** The gateway's own typed command bindings, by name (the dispatch table). */
const COMMAND_BINDINGS = [
  'captureFieldObservation',
  'recordCostItem',
  'submitWorkflowApproval',
  'approveWorkflowApproval',
  'advanceWorkflowInstance',
] as const;

type CommandBinding = (typeof COMMAND_BINDINGS)[number];

/** The typed outcome of one binding call (the gateway's own union). */
type CommandOutcome = Awaited<ReturnType<HostRuntime['commands']['captureFieldObservation']>>;

/** The request envelope: { command: <binding name>, request: <untrusted input> }. */
interface CommandEnvelope {
  readonly command: CommandBinding;
  readonly request: unknown;
}

const invalidEnvelope = (message: string): HostInputRejection => ({
  code: 'invalid-request',
  message,
  details: [],
});

const parseCommandEnvelope = (
  raw: unknown,
): { readonly ok: true; readonly value: CommandEnvelope } | { readonly ok: false; readonly error: HostInputRejection } => {
  if (!isRecord(raw) || typeof raw.command !== 'string' || !('request' in raw)) {
    return {
      ok: false,
      error: invalidEnvelope(
        `expected { command, request } with a string 'command', received ${typeof raw}`,
      ),
    };
  }
  const command = COMMAND_BINDINGS.find((candidate) => candidate === raw.command);
  if (command === undefined) {
    return {
      ok: false,
      error: invalidEnvelope(
        `unknown command '${raw.command}' (expected one of: ${COMMAND_BINDINGS.join(', ')})`,
      ),
    };
  }
  return { ok: true, value: { command, request: raw.request } };
};

/** Dispatch to the runtime's own typed binding (each case fully typed). */
const dispatchCommand = async (
  commands: HostRuntime['commands'],
  envelope: CommandEnvelope,
): Promise<CommandOutcome> => {
  switch (envelope.command) {
    case 'captureFieldObservation':
      return commands.captureFieldObservation(envelope.request);
    case 'recordCostItem':
      return commands.recordCostItem(envelope.request);
    case 'submitWorkflowApproval':
      return commands.submitWorkflowApproval(envelope.request);
    case 'approveWorkflowApproval':
      return commands.approveWorkflowApproval(envelope.request);
    case 'advanceWorkflowInstance':
      return commands.advanceWorkflowInstance(envelope.request);
  }
};

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    if (!body.ok) return Response.json(body.error, { status: 400 });
    const envelope = parseCommandEnvelope(body.value);
    if (!envelope.ok) return Response.json(envelope.error, { status: 400 });
    const runtime = await getHostRuntime();
    const outcome = await dispatchCommand(runtime.commands, envelope.value);
    if ('rejected' in outcome) {
      // The gateway's fail-closed input rejection of the request itself.
      return Response.json(outcome, { status: 400 });
    }
    if (outcome.status === 'rejected') {
      // The command's own typed rejection view (displayable, never a throw).
      return Response.json(outcome, { status: 422 });
    }
    return Response.json(outcome);
  } catch (cause) {
    return operationalFailureResponse(cause);
  }
}
