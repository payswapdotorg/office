// Office canonical contracts — schema versioning (OFF-002).
//
// Fail-closed versioning rule (freeze: "no unversioned external
// synchronization"; DoD: "Event schema/versioning is explicit"): a schema
// version parses only when it is a well-formed semantic version string AND
// explicitly listed in KNOWN_SCHEMA_VERSIONS. Unknown versions produce a
// typed 'unknown-schema-version' parse error — never silent acceptance.
//
// Extending KNOWN_SCHEMA_VERSIONS is a deliberate contract change owned by
// this package (contracts owner or Tech Lead approval, per the dependency
// rule). Envelope shapes are strict: new fields require a new known version.
import { describeValue, parseFail, parseOk } from './parse';
import type { ParseResult } from './parse';

/** Compile-time shape of a semantic version string (TS5 template literal). */
export type SemverString = `${number}.${number}.${number}`;

/** Schema versions this contract release understands. */
export const KNOWN_SCHEMA_VERSIONS = ['1.0.0'] as const satisfies readonly SemverString[];

/** A known, supported envelope schema version. */
export type SchemaVersion = (typeof KNOWN_SCHEMA_VERSIONS)[number];

/** The schema version new envelopes should be written with. */
export const CURRENT_SCHEMA_VERSION: SchemaVersion = '1.0.0';

/** Shape description used in parse failures. */
export const SCHEMA_VERSION_GRAMMAR = `semantic version MAJOR.MINOR.PATCH, one of: ${KNOWN_SCHEMA_VERSIONS.join(', ')}`;

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Parse an untrusted value as a known SchemaVersion (total, fail-closed).
 * Well-formed but unknown versions fail with code 'unknown-schema-version'.
 */
export function parseSchemaVersion(raw: unknown): ParseResult<SchemaVersion> {
  if (typeof raw !== 'string') {
    return parseFail('invalid-type', '', SCHEMA_VERSION_GRAMMAR, describeValue(raw));
  }
  if (!SEMVER_PATTERN.test(raw)) {
    return parseFail('invalid-value', '', 'semantic version MAJOR.MINOR.PATCH', describeValue(raw));
  }
  if (!(KNOWN_SCHEMA_VERSIONS as readonly string[]).includes(raw)) {
    return parseFail('unknown-schema-version', '', SCHEMA_VERSION_GRAMMAR, describeValue(raw));
  }
  return parseOk(raw as SchemaVersion);
}

/** Type guard for known SchemaVersion values. */
export function isKnownSchemaVersion(raw: unknown): raw is SchemaVersion {
  return parseSchemaVersion(raw).ok;
}
