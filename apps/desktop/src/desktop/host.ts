// Office desktop client protocol/reference shell — THE REFERENCE DESKTOP HOST
// (OFF-032).
//
// The in-memory deterministic implementation of THE PLATFORM SHELL HOST-PORT
// CONTRACT (host-port.ts): one factory, `createReferenceDesktopHost(world)`,
// wiring every declared port member over the SEEDED DESKTOP WORLD through the
// desktop shell's own session/data-plane/command modules — which themselves
// compose THE SAME @office/sync + @office/client-sync client protocol the web
// and field shells consume (the A9 subscription + project slice, the offline
// engine: capture disconnected, reconnect, the exactly-once drain, conflict
// surfacing, the typed explicit resolution). The reference host is the
// PROTOCOL PROOF, not a binary: NO I/O, NO clock reads (every `now` is
// injected by the caller), NO randomness, NO platform-specific domain model
// (every domain term arrives from the shared contracts/domain packages), and
// NO gateway construction (the A8 seam stays TYPE-ONLY in commands.ts).
//
// A real desktop platform host implements the SAME typed shape over its real
// transport, durable queue, and conflict store: `validateDesktopHostPort`
// (host-port.ts) is the fail-closed gate every candidate passes, and the
// shell's view models + command surfaces are unchanged — that is the entire
// point of the port.
import { createDesktopSession } from '../session/session';
import { openDesktopDataPlane } from '../session/stream';
import type { SeededDesktopWorld } from '../session/world';
import { desktopWorkspaceView } from './workspace';
import { syncStatusView, synchronize, disconnect } from './sync';
import {
  captureDesktopMutation,
  offlineQueueView,
  submitDesktopMutation,
} from './commands';
import { conflictStateView, resolveProtectedConflict } from './conflicts';
import type {
  DesktopHostPort,
  DesktopPlaneWiring,
} from '../host-port/host-port';
import type { DesktopSession } from '../session/session';
import type { DesktopDataPlane } from '../session/stream';

/**
 * THE REFERENCE DESKTOP HOST: the in-memory deterministic implementation of
 * the platform shell host-port contract over one seeded desktop world. Pure
 * composition — every member delegates to the shell's own typed surfaces, so
 * the host adds NO logic of its own (the contract's semantics live in the
 * modules it wires; a host that invented behavior would be a second source of
 * truth). Deterministic: the world's injected clock/id suppliers and the
 * caller-supplied `now`/grant wiring are the only time and identity inputs.
 */
export function createReferenceDesktopHost(world: SeededDesktopWorld): DesktopHostPort {
  return {
    kind: 'desktop-host-port',
    identity: {
      // THE session/identity port: the fail-closed session parser (the
      // canonical contracts grammars; typed rejections, never a throw).
      resolveSession: (input) => createDesktopSession(input),
    },
    data: {
      // THE data-plane port: open the session's plane (A9 grant +
      // subscription + the offline engine) and the session-scoped read
      // projections over it (workspace, queue, sync status, conflicts).
      openPlane: (session: DesktopSession, wiring: DesktopPlaneWiring) =>
        openDesktopDataPlane(world, session, wiring),
      workspace: (session: DesktopSession, plane: DesktopDataPlane, now) =>
        desktopWorkspaceView(world, session, plane, now),
      queue: (session: DesktopSession, plane: DesktopDataPlane) =>
        offlineQueueView(plane, session),
      syncStatus: (session: DesktopSession, plane: DesktopDataPlane) =>
        syncStatusView(plane, session),
      conflictState: (session: DesktopSession, plane: DesktopDataPlane) =>
        conflictStateView(world, plane, session),
    },
    commands: {
      // THE command-executor port: the typed command path (online submit,
      // offline capture), the synchronize flow, the connection lifecycle, and
      // the typed explicit conflict resolution (the only protected exit).
      submit: (plane: DesktopDataPlane, session: DesktopSession, request, now) =>
        submitDesktopMutation(plane, session, request, now),
      capture: (plane: DesktopDataPlane, session: DesktopSession, request, now) =>
        captureDesktopMutation(plane, session, request, now),
      synchronize: (plane: DesktopDataPlane, session: DesktopSession, now) =>
        synchronize(plane, session, now),
      disconnect: (plane: DesktopDataPlane, session: DesktopSession) =>
        disconnect(plane, session),
      resolveConflict: (plane: DesktopDataPlane, session: DesktopSession, input, now) =>
        resolveProtectedConflict(plane, session, input, now),
    },
  };
}
