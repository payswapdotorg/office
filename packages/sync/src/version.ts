// Office sync — subscription protocol versioning (OFF-028).
//
// Fail-closed protocol versioning, mirroring the contracts schema-version
// rule (freeze: "no unversioned external synchronization"; the client
// synchronization API is exactly such an external surface): a subscription
// pins ONE protocol version at composition time, every stream message
// carries it, and an unknown version fails closed with a typed parse
// error — never silent acceptance. Two versions are currently understood:
// 1.0.0 (what new subscriptions are written with) and 1.1.0 (a forward
// minor this release already accepts fail-closed — the upgrade target of
// the A9 grant upgrades, see grant.ts).
//
// Extending KNOWN_PROTOCOL_VERSIONS is a deliberate protocol change owned by
// this package (sync owner or Tech Lead approval, per the dependency rule).
// Message and contract shapes are strict: new fields require a new known
// protocol version, and older pinned subscriptions keep working against the
// versions they were composed under.
import { parseFail, parseOk } from '@office/contracts';
import type { ParseResult } from '@office/contracts';
import { describeValue } from './parse';

/** Compile-time shape of a semantic version string (TS5 template literal). */
export type SemverString = `${number}.${number}.${number}`;

/** Subscription protocol versions this package understands. */
export const KNOWN_PROTOCOL_VERSIONS = ['1.0.0', '1.1.0'] as const satisfies readonly SemverString[];

/** A known, supported subscription protocol version. */
export type ProtocolVersion = (typeof KNOWN_PROTOCOL_VERSIONS)[number];

/** The protocol version new subscriptions/messages should be written with. */
export const CURRENT_PROTOCOL_VERSION: ProtocolVersion = '1.0.0';

/** Shape description used in parse failures. */
export const PROTOCOL_VERSION_GRAMMAR = `semantic version MAJOR.MINOR.PATCH, one of: ${KNOWN_PROTOCOL_VERSIONS.join(', ')}`;

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Parse an untrusted value as a known ProtocolVersion (total, fail-closed).
 * Well-formed but unknown versions fail with code 'unknown-protocol-version'.
 */
export function parseProtocolVersion(raw: unknown): ParseResult<ProtocolVersion> {
  if (typeof raw !== 'string') {
    return parseFail('invalid-type', '', PROTOCOL_VERSION_GRAMMAR, describeValue(raw));
  }
  if (!SEMVER_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', 'semantic version MAJOR.MINOR.PATCH', describeValue(raw));
  }
  if (!(KNOWN_PROTOCOL_VERSIONS as readonly string[]).includes(raw)) {
    return parseFail('invalid-value', '', PROTOCOL_VERSION_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as ProtocolVersion);
}

/** Type guard for known ProtocolVersion values. */
export function isProtocolVersion(raw: unknown): raw is ProtocolVersion {
  return parseProtocolVersion(raw).ok;
}
