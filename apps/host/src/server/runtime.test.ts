import { afterEach, describe, expect, it } from 'vitest';
import { __setHostRuntimeForTests, getHostRuntime } from './runtime';
import type { HostRuntime } from '@office/host-gateway';

// OFF-DEPLOY apps/host — the server-only singleton's own behavior: lazy
// boot + memoization (never a module-top-level composition — the Next.js
// build phase must not connect), the test seam routes inject fakes through,
// and the seam reset. The real boot needs no database: the seeded reference
// world materializes in memory and the pg pool connects lazily (never, in
// these tests); each booted runtime is closed through end().
const fakeRuntime = (): HostRuntime => ({ kind: 'host-runtime' }) as unknown as HostRuntime;

describe('the server-only host runtime singleton (OFF-DEPLOY)', () => {
  afterEach(() => {
    __setHostRuntimeForTests(null);
  });

  it('boots lazily on the first request and memoizes ONE runtime', async () => {
    const first = await getHostRuntime();
    expect(first.kind).toBe('host-runtime');
    const second = await getHostRuntime();
    expect(second).toBe(first);
    await first.end();
    // Drop the memoized (now closed) runtime so later boots start fresh.
    __setHostRuntimeForTests(null);
  });

  it('serves the injected test seam verbatim (route tests never boot a real runtime)', async () => {
    const fake = fakeRuntime();
    __setHostRuntimeForTests(fake);
    await expect(getHostRuntime()).resolves.toBe(fake);
  });

  it('clearing the seam resets the memoized runtime', async () => {
    const fake = fakeRuntime();
    __setHostRuntimeForTests(fake);
    await getHostRuntime();
    __setHostRuntimeForTests(null);
    const booted = await getHostRuntime();
    expect(booted).not.toBe(fake);
    expect(booted.kind).toBe('host-runtime');
    await booted.end();
    __setHostRuntimeForTests(null);
  });
});
