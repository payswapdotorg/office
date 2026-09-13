// Office app-sdk — the extension UI contract (OFF-025).
//
// An app NEVER ships executable core code (freeze A7/A8: apps are
// extensions acting through the gateway; the host renders their surfaces).
// Instead the manifest declares UI EXTENSIONS: a typed extension-point id
// from the CLOSED vocabulary this module owns, plus a typed VIEW DESCRIPTOR
// the host renders — headings, text, metrics, and actions that reference a
// declared command binding. There are no arbitrary code references, no file
// paths, no URLs, no scripts anywhere in the descriptor: the host owns
// every pixel and every execution; the app owns only the DECLARATION.
//
// Extending EXTENSION_POINTS or the element vocabulary is an app-sdk owner
// change (this package) — hosts and apps negotiate new surfaces through
// manifest schema versions, never through unknown ids (unknown extension
// points are typed-rejected at parse time).
import { parseCommandName, parseFail, parseOk } from '@office/contracts';
import type { CommandName, ParseResult } from '@office/contracts';
import {
  checkString,
  describeValue,
  isPlainObject,
  parseArrayWith,
  requireFieldWith,
  requireLiteral,
  requireString,
  unknownKeyFailure,
} from './parse';
import { parseViewId } from './identity';
import type { ViewId } from './identity';

/**
 * The closed extension-point vocabulary: the host surfaces an app may
 * extend. Typed ids, in declaration order.
 */
const DECLARED_EXTENSION_POINTS = [
  // Project workspace surfaces (the multi-view project state, freeze A6).
  'project.overview.panel',
  'project.cost.panel',
  'project.schedule.panel',
  'project.quality.panel',
  'project.documents.panel',
  // The app's own configuration surface inside the host.
  'app.settings.section',
] as const;

/** Literal union of the declared extension-point ids (the typed vocabulary). */
export type ExtensionPointId = (typeof DECLARED_EXTENSION_POINTS)[number];

/** The declared extension-point vocabulary, in declaration order. */
export const EXTENSION_POINTS: readonly ExtensionPointId[] = [...DECLARED_EXTENSION_POINTS];

/** Grammar description used in parse failures. */
export const EXTENSION_POINT_GRAMMAR =
  'one of the declared extension points (EXTENSION_POINTS)';

/** Grammar description used in parse failures. */
export const UI_EXTENSION_GRAMMAR =
  "UiExtension: { kind: 'ui-extension', extensionPoint, view } — extensionPoint must be a declared extension point";

/** Grammar description used in parse failures. */
export const VIEW_DESCRIPTOR_GRAMMAR =
  "ViewDescriptor: { kind: 'view', viewId, title, elements: 1..50 typed ViewElements (heading | text | metric | action) }";

const UI_EXTENSION_KEYS = ['kind', 'extensionPoint', 'view'] as const;
const VIEW_KEYS = ['kind', 'viewId', 'title', 'elements'] as const;
const ELEMENT_KINDS = ['heading', 'text', 'metric', 'action'] as const;

const VIEW_TITLE_RULE = { min: 1, max: 200, description: 'view title' } as const;
const ELEMENT_TEXT_RULE = { min: 1, max: 2000, description: 'element text' } as const;
const METRIC_LABEL_RULE = { min: 1, max: 200, description: 'metric label' } as const;
const METRIC_VALUE_RULE = { min: 1, max: 200, description: 'metric value (rendered verbatim)' } as const;
const METRIC_UNIT_RULE = { min: 1, max: 64, description: 'metric unit' } as const;
const ACTION_LABEL_RULE = { min: 1, max: 200, description: 'action label' } as const;

/** The maximum number of elements one view descriptor may declare. */
export const VIEW_MAX_ELEMENTS = 50;

/** Parse an untrusted value as an ExtensionPointId (total, fail-closed). */
export function parseExtensionPointId(raw: unknown): ParseResult<ExtensionPointId> {
  if (typeof raw !== 'string' || !(DECLARED_EXTENSION_POINTS as readonly string[]).includes(raw)) {
    return parseFail(
      'invalid-value',
      '',
      EXTENSION_POINT_GRAMMAR,
      typeof raw === 'string' ? `unknown extension point '${raw}'` : describeValue(raw),
    );
  }
  return parseOk(raw as ExtensionPointId);
}

/** Type guard for declared ExtensionPointId values. */
export function isExtensionPointId(raw: unknown): raw is ExtensionPointId {
  return parseExtensionPointId(raw).ok;
}

/**
 * One typed element of a view descriptor. The host renders each element
 * from its declared values; the ACTION element invokes a command the
 * manifest binds (validation.ts checks the reference against the declared
 * command bindings — an undeclared action reference is typed-rejected).
 */
export type ViewElement =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'metric';
      readonly label: string;
      readonly value: string;
      readonly unit: string | null;
    }
  | { readonly kind: 'action'; readonly label: string; readonly commandName: CommandName };

/** Grammar description used in parse failures. */
export const VIEW_ELEMENT_GRAMMAR =
  "ViewElement: { kind: 'heading', text } | { kind: 'text', text } | { kind: 'metric', label, value, unit? } | { kind: 'action', label, commandName } — typed values only, never code";

/**
 * Parse an untrusted value as a ViewElement (total, fail-closed, strict
 * keys). Exported for this package's modules and tests only — NOT
 * re-exported by src/index.ts.
 */
export const parseViewElement = (raw: unknown): ParseResult<ViewElement> => {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', VIEW_ELEMENT_GRAMMAR, describeValue(raw));
  }
  const elementKind = requireLiteral(raw, 'kind', '', ELEMENT_KINDS);
  if (!elementKind.ok) return elementKind;
  const kind = elementKind.value as ViewElement['kind'];
  if (kind === 'heading') {
    const unknownKey = unknownKeyFailure(raw, ['kind', 'text'], '', VIEW_ELEMENT_GRAMMAR);
    if (unknownKey) return unknownKey;
    const text = requireString(raw, 'text', '', ELEMENT_TEXT_RULE);
    if (!text.ok) return text;
    return parseOk({ kind, text: text.value } satisfies ViewElement);
  }
  if (kind === 'text') {
    const unknownKey = unknownKeyFailure(raw, ['kind', 'text'], '', VIEW_ELEMENT_GRAMMAR);
    if (unknownKey) return unknownKey;
    const text = requireString(raw, 'text', '', ELEMENT_TEXT_RULE);
    if (!text.ok) return text;
    return parseOk({ kind, text: text.value } satisfies ViewElement);
  }
  if (kind === 'metric') {
    const unknownKey = unknownKeyFailure(
      raw,
      ['kind', 'label', 'value', 'unit'],
      '',
      VIEW_ELEMENT_GRAMMAR,
    );
    if (unknownKey) return unknownKey;
    const label = requireString(raw, 'label', '', METRIC_LABEL_RULE);
    if (!label.ok) return label;
    const value = requireString(raw, 'value', '', METRIC_VALUE_RULE);
    if (!value.ok) return value;
    const unit = raw['unit'];
    if (unit === undefined || unit === null) {
      return parseOk({ kind, label: label.value, value: value.value, unit: null } satisfies ViewElement);
    }
    const unitCheck = checkString(unit, METRIC_UNIT_RULE, 'unit');
    if (!unitCheck.ok) return unitCheck;
    return parseOk(
      { kind, label: label.value, value: value.value, unit: unitCheck.value } satisfies ViewElement,
    );
  }
  const unknownKey = unknownKeyFailure(
    raw,
    ['kind', 'label', 'commandName'],
    '',
    VIEW_ELEMENT_GRAMMAR,
  );
  if (unknownKey) return unknownKey;
  const label = requireString(raw, 'label', '', ACTION_LABEL_RULE);
  if (!label.ok) return label;
  const commandName = requireFieldWith(raw, 'commandName', '', parseCommandName);
  if (!commandName.ok) return commandName;
  return parseOk({ kind, label: label.value, commandName: commandName.value } satisfies ViewElement);
};

/** Type guard for structurally valid ViewElement values. */
export function isViewElement(raw: unknown): raw is ViewElement {
  return parseViewElement(raw).ok;
}

/**
 * The typed view descriptor the host renders at an extension point: a
 * stable view id, a title, and 1..50 typed elements. No code references of
 * any kind — the host owns rendering AND execution.
 */
export interface ViewDescriptor {
  readonly kind: 'view';
  /** Stable view id, unique within one app manifest. */
  readonly viewId: ViewId;
  /** Human-readable view title (1..200 characters). */
  readonly title: string;
  /** The typed elements to render (1..50). */
  readonly elements: readonly ViewElement[];
}

/** Parse an untrusted value as a ViewDescriptor (total, fail-closed, strict keys). */
export function parseViewDescriptor(raw: unknown): ParseResult<ViewDescriptor> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', VIEW_DESCRIPTOR_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, VIEW_KEYS, '', VIEW_DESCRIPTOR_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['view']);
  if (!kind.ok) return kind;
  const viewId = requireFieldWith(raw, 'viewId', '', parseViewId);
  if (!viewId.ok) return viewId;
  const title = requireString(raw, 'title', '', VIEW_TITLE_RULE);
  if (!title.ok) return title;
  const elements = requireFieldWith(raw, 'elements', '', (value) =>
    parseArrayWith(value, '', parseViewElement, VIEW_DESCRIPTOR_GRAMMAR),
  );
  if (!elements.ok) return elements;
  if (elements.value.length === 0) {
    return parseFail(
      'invalid-value',
      'elements',
      `1..${VIEW_MAX_ELEMENTS} view elements`,
      'array of length 0',
    );
  }
  if (elements.value.length > VIEW_MAX_ELEMENTS) {
    return parseFail(
      'invalid-value',
      'elements',
      `1..${VIEW_MAX_ELEMENTS} view elements`,
      `array of length ${elements.value.length}`,
    );
  }
  return parseOk(
    {
      kind: 'view',
      viewId: viewId.value,
      title: title.value,
      elements: elements.value,
    } satisfies ViewDescriptor,
  );
}

/** Type guard for structurally valid ViewDescriptor values. */
export function isViewDescriptor(raw: unknown): raw is ViewDescriptor {
  return parseViewDescriptor(raw).ok;
}

/**
 * One UI extension of an app manifest: where the host renders (a declared
 * extension point) and what it renders (the typed view descriptor). The
 * host renders from the descriptor — an app never ships executable core
 * code.
 */
export interface UiExtension {
  readonly kind: 'ui-extension';
  /** The declared host surface this extension renders at. */
  readonly extensionPoint: ExtensionPointId;
  /** The typed view the host renders there. */
  readonly view: ViewDescriptor;
}

/** Parse an untrusted value as a UiExtension (total, fail-closed, strict keys). */
export function parseUiExtension(raw: unknown): ParseResult<UiExtension> {
  if (!isPlainObject(raw)) {
    return parseFail('invalid-type', '', UI_EXTENSION_GRAMMAR, describeValue(raw));
  }
  const unknownKey = unknownKeyFailure(raw, UI_EXTENSION_KEYS, '', UI_EXTENSION_GRAMMAR);
  if (unknownKey) return unknownKey;
  const kind = requireLiteral(raw, 'kind', '', ['ui-extension']);
  if (!kind.ok) return kind;
  const extensionPoint = requireFieldWith(raw, 'extensionPoint', '', parseExtensionPointId);
  if (!extensionPoint.ok) return extensionPoint;
  const view = requireFieldWith(raw, 'view', '', parseViewDescriptor);
  if (!view.ok) return view;
  return parseOk(
    {
      kind: 'ui-extension',
      extensionPoint: extensionPoint.value,
      view: view.value,
    } satisfies UiExtension,
  );
}

/** Type guard for structurally valid UiExtension values. */
export function isUiExtension(raw: unknown): raw is UiExtension {
  return parseUiExtension(raw).ok;
}
