import { describe, expect, it } from 'vitest';
import {
  EXTENSION_POINTS,
  VIEW_MAX_ELEMENTS,
  isExtensionPointId,
  isUiExtension,
  isViewDescriptor,
  isViewElement,
  parseExtensionPointId,
  parseUiExtension,
  parseViewDescriptor,
  parseViewElement,
} from './ui-extensions';
import { unwrap } from './test-support';

// OFF-025 — the extension UI contract: CLOSED extension-point ids, typed
// view descriptors, NO code references of any kind. Unknown extension
// points are typed-rejected at parse time (THE named matrix case).

const VALID_VIEW = {
  kind: 'view',
  viewId: 'progress-summary',
  title: 'Progress',
  elements: [
    { kind: 'heading', text: 'Field progress' },
    { kind: 'metric', label: 'Completion', value: '82', unit: '%' },
    { kind: 'action', label: 'Record progress', commandName: 'field.recordProgress' },
  ],
} as const;

const VALID_EXTENSION = {
  kind: 'ui-extension',
  extensionPoint: 'project.overview.panel',
  view: VALID_VIEW,
} as const;

describe('the closed extension-point vocabulary', () => {
  it('declares typed host surfaces only', () => {
    expect(EXTENSION_POINTS).toStrictEqual([
      'project.overview.panel',
      'project.cost.panel',
      'project.schedule.panel',
      'project.quality.panel',
      'project.documents.panel',
      'app.settings.section',
    ]);
    expect(isExtensionPointId('project.overview.panel')).toBe(true);
  });

  it('rejects unknown extension points (THE named matrix case)', () => {
    for (const bad of [
      'project.map.panel', // well-formed but undeclared
      'project.overview', // partial
      'global.sidebar.widget', // undeclared surface
      'Project.Overview.Panel', // case
      '*', // wildcard
      '',
      42,
      null,
    ]) {
      const result = parseExtensionPointId(bad);
      expect(result.ok, `extension point ${JSON.stringify(bad)}`).toBe(false);
      if (!result.ok && typeof bad === 'string') {
        expect(result.error.code).toBe('invalid-value');
        expect(result.error.received).toContain(bad);
      }
      expect(isExtensionPointId(bad)).toBe(false);
    }
  });
});

describe('view elements (ViewElement)', () => {
  it('parses every typed element kind, defaulting metric unit to null', () => {
    expect(unwrap(parseViewElement({ kind: 'heading', text: 'Field progress' }))).toStrictEqual({
      kind: 'heading',
      text: 'Field progress',
    });
    expect(unwrap(parseViewElement({ kind: 'text', text: 'Yesterday: 82% complete.' }))).toStrictEqual({
      kind: 'text',
      text: 'Yesterday: 82% complete.',
    });
    expect(
      unwrap(parseViewElement({ kind: 'metric', label: 'Completion', value: '82', unit: '%' })),
    ).toStrictEqual({ kind: 'metric', label: 'Completion', value: '82', unit: '%' });
    expect(
      unwrap(parseViewElement({ kind: 'metric', label: 'Open issues', value: '7' })),
    ).toStrictEqual({ kind: 'metric', label: 'Open issues', value: '7', unit: null });
    expect(
      unwrap(
        parseViewElement({ kind: 'action', label: 'Record progress', commandName: 'field.recordProgress' }),
      ),
    ).toStrictEqual({ kind: 'action', label: 'Record progress', commandName: 'field.recordProgress' });
    expect(isViewElement({ kind: 'heading', text: 'x' })).toBe(true);
  });

  it('rejects malformed elements fail-closed — code references are unrepresentable', () => {
    for (const bad of [
      null,
      'heading',
      {},
      { kind: 'script' },
      { kind: 'iframe' },
      { kind: 'image', src: 'https://evil.example/x.js' },
      { kind: 'heading' },
      { kind: 'heading', text: '' },
      { kind: 'heading', text: 42 },
      { kind: 'heading', text: 'x', commandName: 'field.recordProgress' },
      { kind: 'text', text: null },
      { kind: 'metric' },
      { kind: 'metric', label: '', value: '82' },
      { kind: 'metric', label: 'Completion' },
      { kind: 'metric', label: 'Completion', value: '' },
      { kind: 'metric', label: 'Completion', value: '82', unit: '' },
      { kind: 'metric', label: 'Completion', value: '82', unit: 5 },
      { kind: 'action' },
      { kind: 'action', label: 'Go', commandName: 'notACommand' },
      { kind: 'action', label: 'Go', commandName: 'field.recordProgress', extra: 'href' },
    ]) {
      expect(parseViewElement(bad).ok, `element ${JSON.stringify(bad)}`).toBe(false);
      expect(isViewElement(bad)).toBe(false);
    }
  });
});

describe('view descriptors (ViewDescriptor)', () => {
  it('parses a valid view unchanged', () => {
    expect(unwrap(parseViewDescriptor(VALID_VIEW))).toStrictEqual(VALID_VIEW);
    expect(isViewDescriptor(VALID_VIEW)).toBe(true);
  });

  it('rejects empty and oversized element lists fail-closed', () => {
    const empty = parseViewDescriptor({ ...VALID_VIEW, elements: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe('invalid-value');
      expect(empty.error.path).toBe('elements');
    }
    const oversized = parseViewDescriptor({
      ...VALID_VIEW,
      elements: Array.from({ length: VIEW_MAX_ELEMENTS + 1 }, () => ({ kind: 'text', text: 'x' })),
    });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.error.path).toBe('elements');
    }
  });

  it('rejects malformed views fail-closed (ids, titles, strict keys)', () => {
    for (const bad of [
      null,
      [],
      'view',
      { ...VALID_VIEW, kind: 'panel' },
      { ...VALID_VIEW, viewId: 'Progress Summary' },
      { ...VALID_VIEW, viewId: '' },
      { ...VALID_VIEW, title: '' },
      { ...VALID_VIEW, title: 'x'.repeat(201) },
      { ...VALID_VIEW, elements: 'many' },
      { ...VALID_VIEW, extra: true },
      { kind: 'view', viewId: 'progress-summary', title: 'Progress' },
    ]) {
      expect(parseViewDescriptor(bad).ok, `view ${JSON.stringify(bad)}`).toBe(false);
      expect(isViewDescriptor(bad)).toBe(false);
    }
  });
});

describe('UI extensions (UiExtension)', () => {
  it('parses a valid extension unchanged', () => {
    expect(unwrap(parseUiExtension(VALID_EXTENSION))).toStrictEqual(VALID_EXTENSION);
    expect(isUiExtension(VALID_EXTENSION)).toBe(true);
  });

  it('rejects extensions with unknown points or malformed views fail-closed', () => {
    for (const bad of [
      null,
      'extension',
      { ...VALID_EXTENSION, kind: 'extension' },
      { ...VALID_EXTENSION, extensionPoint: 'project.map.panel' },
      { ...VALID_EXTENSION, extensionPoint: '*' },
      { ...VALID_EXTENSION, extensionPoint: null },
      { ...VALID_EXTENSION, view: null },
      { ...VALID_EXTENSION, view: { ...VALID_VIEW, viewId: 'Bad Id' } },
      { ...VALID_EXTENSION, extra: 1 },
    ]) {
      expect(parseUiExtension(bad).ok, `extension ${JSON.stringify(bad)}`).toBe(false);
      expect(isUiExtension(bad)).toBe(false);
    }
  });
});
