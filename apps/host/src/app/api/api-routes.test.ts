import { afterEach, describe, expect, it } from 'vitest';
import { __setHostRuntimeForTests } from '../../server/runtime';
import { GET as getHealth } from './health/route';
import { GET as getWorkspace } from './workspace/route';
import { POST as postCommands } from './commands/route';
import { POST as postActions } from './actions/route';
import { GET as getLedger } from './ledger/route';
import type { HostRuntime } from '@office/host-gateway';

// OFF-DEPLOY apps/host — the API route modules' exported behavior, driven
// through the singleton's test seam with STRUCTURAL fake runtimes (only the
// members the route under test touches — the seam's contract). Every route
// answers with typed JSON: a typed rejection is a 4xx body, never a thrown
// error; the health route implements the 200/503 readiness contract.
const fakeRuntime = (members: Record<string, unknown>): HostRuntime =>
  ({ kind: 'host-runtime', ...members }) as unknown as HostRuntime;

const jsonRequest = (url: string, body?: string): Request =>
  new Request(url, {
    method: 'POST',
    ...(body === undefined ? {} : { body }),
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  __setHostRuntimeForTests(null);
});

describe('/api/health — THE readiness endpoint', () => {
  it('GET returns the typed HealthReport with 200 when the database is reachable', async () => {
    const report = {
      kind: 'host-health',
      database: 'reachable',
      migrations: { appliedCount: 6, latestName: '0101-projects-extension' },
      release: 'test-release-0001',
    };
    __setHostRuntimeForTests(fakeRuntime({ health: async () => report }));
    const response = await getHealth();
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual(report);
  });

  it('GET returns the typed HealthReport with 503 when the database is unreachable', async () => {
    const report = {
      kind: 'host-health',
      database: 'unreachable',
      migrations: { appliedCount: 0, latestName: null },
      release: 'test-release-0001',
    };
    __setHostRuntimeForTests(fakeRuntime({ health: async () => report }));
    const response = await getHealth();
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual(report);
  });
});

describe('/api/workspace — the workspace view model', () => {
  it('GET returns the workspace view model with 200', async () => {
    const value = {
      kind: 'project-workspace',
      header: { projectName: 'Reference Campus Works', projectStatus: 'active' },
    };
    __setHostRuntimeForTests(
      fakeRuntime({ reads: { workspace: async () => ({ ok: true, value }) } }),
    );
    const response = await getWorkspace();
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual(value);
  });

  it('GET maps the typed not-found rejection to 404 (A12 — no existence oracle)', async () => {
    __setHostRuntimeForTests(
      fakeRuntime({
        reads: {
          workspace: async () => ({
            ok: false,
            error: { code: 'not-found', message: 'no such tenant', details: [] },
          }),
        },
      }),
    );
    const response = await getWorkspace();
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('not-found');
    expect(body.message).toBe('no such tenant');
  });
});

describe('/api/commands — the typed command bindings', () => {
  const fieldRequest = {
    category: 'site-condition',
    summary: 'Level 3 slab cracking observed at grid C4',
    location: 'level-3/grid-c4',
    observedAt: '2026-09-14T09:05:00.000Z',
    observedBy: 'host-operator-0001',
  };

  it('POST dispatches by the command discriminator and returns the executed outcome with 200', async () => {
    const received: unknown[] = [];
    __setHostRuntimeForTests(
      fakeRuntime({
        commands: {
          captureFieldObservation: async (request: unknown) => {
            received.push(request);
            return {
              status: 'executed',
              command: {
                commandName: 'field.captureFieldEvent',
                actorKind: 'user',
                actorId: 'host-operator-0001',
                issuedAt: '2026-09-14T10:00:00.000Z',
              },
              operationId: 'capture-0001',
              eventId: 'evt-0001',
              eventName: 'field.fieldEventCaptured',
              rejection: null,
            };
          },
        },
      }),
    );
    const response = await postCommands(
      jsonRequest('http://localhost/api/commands', JSON.stringify({ command: 'captureFieldObservation', request: fieldRequest })),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; eventId: string | null };
    expect(body.status).toBe('executed');
    expect(body.eventId).toBe('evt-0001');
    expect(received).toStrictEqual([fieldRequest]);
  });

  it('POST returns the command\'s own typed rejection view with 422', async () => {
    __setHostRuntimeForTests(
      fakeRuntime({
        commands: {
          captureFieldObservation: async () => ({
            status: 'rejected',
            command: {
              commandName: 'field.captureFieldEvent',
              actorKind: 'user',
              actorId: 'host-operator-0001',
              issuedAt: '2026-09-14T10:00:00.000Z',
            },
            operationId: null,
            eventId: null,
            eventName: null,
            rejection: { code: 'unauthorized', message: 'scope', details: [] },
          }),
        },
      }),
    );
    const response = await postCommands(
      jsonRequest('http://localhost/api/commands', JSON.stringify({ command: 'captureFieldObservation', request: fieldRequest })),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as { status: string; rejection: { code: string } };
    expect(body.status).toBe('rejected');
    expect(body.rejection.code).toBe('unauthorized');
  });

  it('POST returns the gateway\'s fail-closed input rejection with 400', async () => {
    __setHostRuntimeForTests(
      fakeRuntime({
        commands: {
          captureFieldObservation: async () => ({
            rejected: {
              code: 'invalid-request',
              message: "invalid request at 'category': expected a non-empty string",
              details: [],
            },
          }),
        },
      }),
    );
    const response = await postCommands(
      jsonRequest('http://localhost/api/commands', JSON.stringify({ command: 'captureFieldObservation', request: { category: '' } })),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { rejected: { code: string } };
    expect(body.rejected.code).toBe('invalid-request');
  });

  it('POST rejects a malformed JSON body with 400', async () => {
    __setHostRuntimeForTests(fakeRuntime({ commands: {} }));
    const response = await postCommands(jsonRequest('http://localhost/api/commands', '{not json'));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('invalid-request');
  });

  it('POST rejects an unknown command discriminator with 400', async () => {
    __setHostRuntimeForTests(fakeRuntime({ commands: {} }));
    const response = await postCommands(
      jsonRequest('http://localhost/api/commands', JSON.stringify({ command: 'explodeProject', request: {} })),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('invalid-request');
    expect(body.message).toContain('explodeProject');
  });

  it('POST rejects a non-object body with 400', async () => {
    __setHostRuntimeForTests(fakeRuntime({ commands: {} }));
    const response = await postCommands(jsonRequest('http://localhost/api/commands', '42'));
    expect(response.status).toBe(400);
  });
});

describe('/api/actions — the A8 approval-gated action', () => {
  const decisionRequest = {
    instanceId: 'wf-instance-0001',
    expectedVersion: 0,
    approvalKey: 'field-verification',
    basis: 'evt-0001',
  };

  it('POST propose returns the routed approval reference with 200', async () => {
    const received: unknown[] = [];
    __setHostRuntimeForTests(
      fakeRuntime({
        actions: {
          proposeApprovalDecision: async (request: unknown) => {
            received.push(request);
            return {
              ok: true,
              value: {
                decision: 'routed-to-approval',
                approval: { instanceId: 'wf-instance-0001', approvalKey: 'field-verification' },
              },
            };
          },
        },
      }),
    );
    const response = await postActions(
      jsonRequest('http://localhost/api/actions', JSON.stringify({ stage: 'propose', request: decisionRequest })),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      decision: string;
      approval: { instanceId: string; approvalKey: string };
    };
    expect(body.decision).toBe('routed-to-approval');
    expect(body.approval).toStrictEqual({
      instanceId: 'wf-instance-0001',
      approvalKey: 'field-verification',
    });
    expect(received).toStrictEqual([decisionRequest]);
  });

  it('POST propose maps the typed unauthorized rejection to 403', async () => {
    __setHostRuntimeForTests(
      fakeRuntime({
        actions: {
          proposeApprovalDecision: async () => ({
            ok: false,
            error: { code: 'unauthorized', message: 'missing capability', details: [] },
          }),
        },
      }),
    );
    const response = await postActions(
      jsonRequest('http://localhost/api/actions', JSON.stringify({ stage: 'propose', request: decisionRequest })),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('unauthorized');
  });

  it('POST propose maps a fail-closed input rejection to 400', async () => {
    __setHostRuntimeForTests(
      fakeRuntime({
        actions: {
          proposeApprovalDecision: async () => ({
            ok: false,
            error: {
              code: 'invalid-request',
              message: "invalid request at 'basis': expected a non-empty string",
              details: [],
            },
          }),
        },
      }),
    );
    const response = await postActions(
      jsonRequest('http://localhost/api/actions', JSON.stringify({ stage: 'propose', request: { ...decisionRequest, basis: '' } })),
    );
    expect(response.status).toBe(400);
  });

  it('POST complete executes the approval-gated action and returns the executed outcome with 200', async () => {
    const seen: { request: unknown; approval: unknown }[] = [];
    // A canonical EntityId (the landed grammar the gateway's fail-closed
    // reference parser enforces: office-ent-v1-<opaque>).
    const approval = {
      instanceId: 'office-ent-v1-a9b8c7d6e5f4130293847565647382910',
      approvalKey: 'field-verification',
    };
    __setHostRuntimeForTests(
      fakeRuntime({
        actions: {
          completeApprovalDecision: async (request: unknown, passedApproval: unknown) => {
            seen.push({ request, approval: passedApproval });
            return {
              ok: true,
              value: {
                decision: 'executed',
                replayed: false,
                value: {
                  status: 'executed',
                  command: {
                    commandName: 'workflows.approveApproval',
                    actorKind: 'user',
                    actorId: 'host-operator-0001',
                    issuedAt: '2026-09-14T10:00:00.000Z',
                  },
                  operationId: 'approval-0001',
                  eventId: 'evt-0002',
                  eventName: 'workflows.approvalDecided',
                  rejection: null,
                },
              },
            };
          },
        },
      }),
    );
    const response = await postActions(
      jsonRequest('http://localhost/api/actions', JSON.stringify({ stage: 'complete', request: decisionRequest, approval })),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      decision: string;
      replayed: boolean;
      value: { status: string; eventId: string | null };
    };
    expect(body.decision).toBe('executed');
    expect(body.replayed).toBe(false);
    expect(body.value.status).toBe('executed');
    expect(body.value.eventId).toBe('evt-0002');
    expect(seen).toStrictEqual([{ request: decisionRequest, approval }]);
  });

  it('POST complete rejects a missing approval object with 400', async () => {
    __setHostRuntimeForTests(fakeRuntime({ actions: {} }));
    const response = await postActions(
      jsonRequest('http://localhost/api/actions', JSON.stringify({ stage: 'complete', request: decisionRequest })),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('invalid-request');
    expect(body.message).toContain('approval');
  });

  it('POST complete rejects a malformed approval reference with the typed 400 (fail-closed, never a cast)', async () => {
    __setHostRuntimeForTests(fakeRuntime({ actions: {} }));
    const response = await postActions(
      jsonRequest(
        'http://localhost/api/actions',
        JSON.stringify({
          stage: 'complete',
          request: decisionRequest,
          approval: { instanceId: 'wf-instance-0001', approvalKey: 'field-verification' },
        }),
      ),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe('invalid-request');
    expect(body.message).toContain('approval.instanceId');
  });

  it('POST rejects an invalid stage with 400', async () => {
    __setHostRuntimeForTests(fakeRuntime({ actions: {} }));
    const response = await postActions(
      jsonRequest('http://localhost/api/actions', JSON.stringify({ stage: 'explode', request: decisionRequest })),
    );
    expect(response.status).toBe(400);
  });
});

describe('/api/ledger — the evidence read surface', () => {
  it('GET returns the evidence overview with 200', async () => {
    const overview = {
      kind: 'evidence-overview',
      eventCount: 12,
      aggregateCount: 5,
      domains: [{ domain: 'cost', eventCount: 3 }],
      aggregates: [],
    };
    __setHostRuntimeForTests(fakeRuntime({ reads: { evidenceOverview: () => overview } }));
    const response = await getLedger(new Request('http://localhost/api/ledger'));
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual(overview);
  });

  it('GET ?event=<id> returns the event view and its causality chain with 200', async () => {
    const seen: string[] = [];
    __setHostRuntimeForTests(
      fakeRuntime({
        reads: {
          evidenceOverview: () => ({ kind: 'evidence-overview' }),
          evidenceEvent: (_session: undefined, eventId: string) => {
            seen.push(eventId);
            return {
              ok: true,
              value: { eventId, eventName: 'cost.costItemRecorded', sequence: 1 },
            };
          },
          causalityChain: (_session: undefined, eventId: string) => ({
            ok: true,
            value: { kind: 'evidence-causality', eventId, depth: 2, entries: [] },
          }),
        },
      }),
    );
    const response = await getLedger(new Request('http://localhost/api/ledger?event=evt-0042'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      event: { eventId: string; eventName: string };
      causality: { kind: string; depth: number };
    };
    expect(body.event.eventId).toBe('evt-0042');
    expect(body.event.eventName).toBe('cost.costItemRecorded');
    expect(body.causality.depth).toBe(2);
    expect(seen).toStrictEqual(['evt-0042']);
  });

  it('GET ?event=<unknown id> maps the typed not-found rejection to 404', async () => {
    __setHostRuntimeForTests(
      fakeRuntime({
        reads: {
          evidenceOverview: () => ({ kind: 'evidence-overview' }),
          evidenceEvent: () => ({
            ok: false,
            error: { code: 'not-found', message: 'no such event', details: [] },
          }),
        },
      }),
    );
    const response = await getLedger(new Request('http://localhost/api/ledger?event=evt-missing'));
    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('not-found');
  });
});
