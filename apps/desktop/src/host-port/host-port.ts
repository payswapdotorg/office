// Office desktop client protocol/reference shell — THE PLATFORM SHELL
// HOST-PORT CONTRACT (OFF-032).
//
// The typed contract EVERY desktop platform host must satisfy to host the
// Office desktop shell: three named ports — the SESSION/IDENTITY port (how
// the host resolves the desktop session), the DATA-PLANE port (how the host
// provides the subscribed project slice + the offline engine surface: the
// A9 subscription, the bounded local queue, the reconnect drain, the
// conflict records), and the COMMAND-EXECUTOR port (how the host executes
// the shell's typed command surface: online submissions, offline captures,
// the synchronize flow, the explicit conflict resolution). The REFERENCE
// DESKTOP HOST (src/desktop/host.ts) is the in-memory deterministic
// implementation of this contract over THE SAME @office/sync +
// @office/client-sync client protocol the web and field shells consume; a
// real platform host implements the same typed shape over its real
// transport, durable queue, and conflict store — the shell's view models and
// command surfaces are unchanged.
//
// The contract is TYPED and FAIL-CLOSED: `validateDesktopHostPort` parses an
// unknown candidate structurally (strict keys, every declared member present
// and callable, the exact port kind) and typed-rejects anything malformed —
// a host missing its command executor, say, is a typed rejection naming the
// missing member's path, never a silent partial host. The descriptor below
// is the JSON-safe manifest of the contract (what OFF-037 and the successor
// platform teams consume when wiring a real host).
//
// Pure typed data + pure validation: no I/O, no clock, no randomness, no
// platform-specific domain model — every domain term in the contract's
// surface arrives from the shared contracts/domain packages' public types.
import type { DomainError, Result } from '@office/domain-kernel';
import type { Timestamp } from '@office/contracts';
import type { DesktopSession, DesktopSessionInput, DesktopSessionRejection } from '../session/session';
import type { DesktopDataPlane, DesktopMutationRequest } from '../session/stream';
import type {
  CaptureOutcomeView,
  OfflineQueueView,
  SubmissionOutcomeView,
} from '../desktop/commands';
import type { DesktopWorkspaceView } from '../desktop/workspace';
import type { SyncStatusView, SynchronizeRejection, SyncReportView } from '../desktop/sync';
import type { ConflictStateView, ResolutionOutcomeView, ResolveConflictInput } from '../desktop/conflicts';

/** The wiring of one data-plane opening (deterministic, caller-supplied). */
export interface DesktopPlaneWiring {
  /** Injected clock — the canonical 'now' of the grant issuance (never wall time). */
  readonly now: () => Timestamp;
  /** The A9 grant serial (deterministic, caller-supplied). */
  readonly serial?: number;
  /** The subscription ordinal (deterministic, caller-supplied). */
  readonly ordinal?: number;
}

// ---------------------------------------------------------------------------
// THE three named ports of the platform shell host contract.
// ---------------------------------------------------------------------------

/**
 * THE SESSION/IDENTITY PORT: how the host resolves the desktop session —
 * the tenant/project/acting-user identity, parsed fail-closed through the
 * canonical contracts grammars, with the session's deny-by-default policy
 * and closed capability set. Cross-tenant and cross-project identities are
 * typed rejections (freeze A12).
 */
export interface DesktopHostIdentityPort {
  resolveSession(
    input: DesktopSessionInput,
  ): Result<DesktopSession, DesktopSessionRejection>;
}

/**
 * THE DATA-PLANE PORT: how the host provides the shell's data plane — ONE
 * subscribed project slice over the A9 grant chain (@office/sync: the
 * subscription contract, the slice cursor discipline, the live stream) with
 * @office/client-sync's offline engine composed behind it (the bounded
 * LocalQueue, the exactly-once reconnect drain, the conflict records), plus
 * the shell's read projections over it (the workspace view model, the queue
 * view, the sync status view, the conflict state view). Every read is
 * session-scoped (A12: a foreign session is a typed rejection, never data).
 */
export interface DesktopHostDataPlanePort {
  /** Open the session's data plane (the A9 grant + subscription + engine). */
  openPlane(
    session: DesktopSession,
    wiring: DesktopPlaneWiring,
  ): Promise<DesktopDataPlane>;
  /** The workspace view model over the session's subscribed slice (A11). */
  workspace(
    session: DesktopSession,
    plane: DesktopDataPlane,
    now: Timestamp | null,
  ): Promise<Result<DesktopWorkspaceView, DomainError>>;
  /** The offline queue's displayable state (the disconnected captures). */
  queue(session: DesktopSession, plane: DesktopDataPlane): Result<OfflineQueueView, DomainError>;
  /** The cursor/token state displayable at every step. */
  syncStatus(session: DesktopSession, plane: DesktopDataPlane): Result<SyncStatusView, DomainError>;
  /** The conflict state surface (both sides + provenance + disposition). */
  conflictState(
    session: DesktopSession,
    plane: DesktopDataPlane,
  ): Result<ConflictStateView, DomainError>;
}

/**
 * THE COMMAND-EXECUTOR PORT: how the host executes the shell's typed command
 * surface — online submissions through the typed command path, offline
 * captures into the bounded local queue, the synchronize flow (the
 * exactly-once reconnect drain), and the explicit conflict resolution (the
 * only protected exit). Commands surface typed Results (displayable
 * rejections), never throws; authorization holds on every submission and
 * every replay (A8/A9/A12).
 */
export interface DesktopHostCommandPort {
  /** Submit one composed desktop mutation ONLINE (the typed command path). */
  submit(
    plane: DesktopDataPlane,
    session: DesktopSession,
    request: DesktopMutationRequest,
    now: Timestamp,
  ): Promise<SubmissionOutcomeView>;
  /** Capture one composed desktop mutation OFFLINE (the bounded queue). */
  capture(
    plane: DesktopDataPlane,
    session: DesktopSession,
    request: DesktopMutationRequest,
    now: Timestamp,
  ): CaptureOutcomeView;
  /** The synchronize flow: catchup + the exactly-once drain + conflicts. */
  synchronize(
    plane: DesktopDataPlane,
    session: DesktopSession,
    now: Timestamp,
  ): Promise<Result<SyncReportView, SynchronizeRejection>>;
  /** The connection lifecycle: disconnect the session (captures accumulate). */
  disconnect(
    plane: DesktopDataPlane,
    session: DesktopSession,
  ): Result<true, SynchronizeRejection>;
  /** THE explicit resolution — the ONLY exit from a protected conflict. */
  resolveConflict(
    plane: DesktopDataPlane,
    session: DesktopSession,
    input: ResolveConflictInput,
    now: Timestamp,
  ): Promise<ResolutionOutcomeView>;
}

/** THE platform shell host-port contract: the three named ports, ONE record. */
export interface DesktopHostPort {
  readonly kind: 'desktop-host-port';
  /** The session/identity port. */
  readonly identity: DesktopHostIdentityPort;
  /** The data-plane port (the subscribed slice + the offline engine + reads). */
  readonly data: DesktopHostDataPlanePort;
  /** The command-executor port (the typed command path + the sync flow). */
  readonly commands: DesktopHostCommandPort;
}

// ---------------------------------------------------------------------------
// The typed, JSON-safe contract descriptor (what OFF-037 / platform teams
// consume when wiring a real desktop platform host).
// ---------------------------------------------------------------------------

/** One declared member of one declared port section of the host contract. */
export interface DesktopHostPortMember {
  readonly name: string;
  readonly description: string;
}

/** One declared port section of the host contract. */
export interface DesktopHostPortSection {
  readonly name: 'identity' | 'data' | 'commands';
  readonly description: string;
  readonly members: readonly DesktopHostPortMember[];
}

/** THE platform shell host-port contract descriptor (JSON-safe, frozen). */
export const DESKTOP_HOST_PORT_CONTRACT: readonly DesktopHostPortSection[] = [
  {
    name: 'identity',
    description:
      'the session/identity port: resolve the desktop session (tenant/project/actor, deny-by-default policy, closed capability set) — cross-tenant and cross-project identities typed-rejected (A12)',
    members: [
      { name: 'resolveSession', description: 'parse + resolve the session identity (fail-closed, typed rejections)' },
    ],
  },
  {
    name: 'data',
    description:
      'the data-plane port: the subscribed project slice over the A9 grant chain (@office/sync) with @office/client-sync offline engine composed behind it, plus the session-scoped read projections',
    members: [
      { name: 'openPlane', description: 'open the session data plane (grant + subscription + engine)' },
      { name: 'workspace', description: 'the project workspace view model over the subscribed slice (A11)' },
      { name: 'queue', description: 'the offline queue view (pending count, entries, protection classes)' },
      { name: 'syncStatus', description: 'the cursor/token state view' },
      { name: 'conflictState', description: 'the conflict state view (both sides + provenance + disposition)' },
    ],
  },
  {
    name: 'commands',
    description:
      'the command-executor port: the typed command path (online submissions, offline captures), the synchronize flow, and the explicit conflict resolution',
    members: [
      { name: 'submit', description: 'execute one composed desktop mutation online (typed Results)' },
      { name: 'capture', description: 'capture one composed desktop mutation offline (bounded queue)' },
      { name: 'synchronize', description: 'reconnect + the exactly-once drain + conflict surfacing' },
      { name: 'disconnect', description: 'the connection lifecycle (captures accumulate)' },
      { name: 'resolveConflict', description: 'the typed explicit resolution — the only protected exit' },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// The fail-closed structural validation of one host-port candidate.
// ---------------------------------------------------------------------------

/** Why a host-port candidate was rejected (displayable, typed — never a throw). */
export type DesktopHostPortRejection =
  | { readonly code: 'host-port-not-an-object'; readonly received: string }
  | { readonly code: 'host-port-kind'; readonly received: string }
  | { readonly code: 'host-port-section-missing'; readonly path: string }
  | { readonly code: 'host-port-member-missing'; readonly path: string }
  | { readonly code: 'host-port-member-not-callable'; readonly path: string }
  | { readonly code: 'host-port-unknown-section'; readonly path: string };

/** The required member names of each declared port section. */
const REQUIRED_MEMBERS: Readonly<Record<'identity' | 'data' | 'commands', readonly string[]>> = {
  identity: ['resolveSession'],
  data: ['openPlane', 'workspace', 'queue', 'syncStatus', 'conflictState'],
  commands: ['submit', 'capture', 'synchronize', 'disconnect', 'resolveConflict'],
};

const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);

/**
 * Validate one host-port candidate FAIL-CLOSED against the platform shell
 * contract: the exact port kind, exactly the three declared sections, every
 * declared member present and callable, and NO unknown section (strict keys
 * — a host carrying extra sections is as malformed as one missing them).
 * A malformed host port is a typed rejection naming the offending path —
 * never a silent partial host, never a throw.
 */
export function validateDesktopHostPort(
  candidate: unknown,
): Result<DesktopHostPort, DesktopHostPortRejection> {
  if (!isRecord(candidate)) {
    return {
      ok: false,
      error: { code: 'host-port-not-an-object', received: typeof candidate },
    };
  }
  if (candidate['kind'] !== 'desktop-host-port') {
    return {
      ok: false,
      error: { code: 'host-port-kind', received: String(candidate['kind']) },
    };
  }
  const declaredSections = new Set<string>(['identity', 'data', 'commands']);
  for (const section of Object.keys(candidate)) {
    if (section === 'kind') continue;
    if (!declaredSections.has(section)) {
      return {
        ok: false,
        error: { code: 'host-port-unknown-section', path: section },
      };
    }
  }
  for (const [sectionName, memberNames] of Object.entries(REQUIRED_MEMBERS)) {
    const section = candidate[sectionName];
    if (!isRecord(section)) {
      return {
        ok: false,
        error: { code: 'host-port-section-missing', path: sectionName },
      };
    }
    for (const memberName of memberNames) {
      const member = section[memberName];
      if (member === undefined) {
        return {
          ok: false,
          error: { code: 'host-port-member-missing', path: `${sectionName}.${memberName}` },
        };
      }
      if (typeof member !== 'function') {
        return {
          ok: false,
          error: { code: 'host-port-member-not-callable', path: `${sectionName}.${memberName}` },
        };
      }
    }
  }
  return { ok: true, value: candidate as unknown as DesktopHostPort };
}
