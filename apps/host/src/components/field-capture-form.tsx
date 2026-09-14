'use client';

// Office browser host — the field-capture command form (OFF-DEPLOY).
//
// ONE typed command binding exercised from the browser: the shell's
// offline-style field-observation capture (captureFieldObservation). The
// form posts the typed request to the app's OWN /api/commands route with a
// RELATIVE URL and renders the typed outcome view the route returns
// (executed / replayed / rejected — rejections are displayable view models,
// never thrown errors). @office/web is imported TYPE-ONLY: type-only imports
// are erased at compile time (the package pulls node:crypto and must never
// enter the client bundle); the value flow is JSON through the app's own
// route. All inputs are labeled; the submit button is a real form submit
// (keyboard operable).
import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { CommandOutcome } from './command-outcome';
import type { SubmissionOutcome } from './command-outcome';

interface FieldCaptureValues {
  readonly category: string;
  readonly summary: string;
  readonly detail: string;
  readonly location: string;
  readonly observedAt: string;
  readonly observedBy: string;
}

const INITIAL_VALUES: FieldCaptureValues = {
  category: 'site-condition',
  summary: '',
  detail: '',
  location: '',
  observedAt: '2026-09-14T09:05:00.000Z',
  observedBy: 'host-operator-0001',
};

export function FieldCaptureForm() {
  const [values, setValues] = useState<FieldCaptureValues>(INITIAL_VALUES);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<SubmissionOutcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const update =
    (field: keyof FieldCaptureValues) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
    };

  const submit = async (): Promise<void> => {
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch('/api/commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          command: 'captureFieldObservation',
          request: {
            category: values.category,
            summary: values.summary,
            ...(values.detail !== '' ? { detail: values.detail } : {}),
            location: values.location,
            observedAt: values.observedAt,
            observedBy: values.observedBy,
          },
        }),
      });
      setOutcome((await response.json()) as SubmissionOutcome);
    } catch (cause) {
      setFailure(String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3>Capture a field observation</h3>
      <p>
        <label htmlFor="capture-category">Category</label>
        <input
          id="capture-category"
          name="category"
          value={values.category}
          onChange={update('category')}
          required
        />
      </p>
      <p>
        <label htmlFor="capture-summary">Summary</label>
        <input
          id="capture-summary"
          name="summary"
          value={values.summary}
          onChange={update('summary')}
          required
        />
      </p>
      <p>
        <label htmlFor="capture-detail">Detail (optional)</label>
        <input
          id="capture-detail"
          name="detail"
          value={values.detail}
          onChange={update('detail')}
        />
      </p>
      <p>
        <label htmlFor="capture-location">Location</label>
        <input
          id="capture-location"
          name="location"
          value={values.location}
          onChange={update('location')}
          required
        />
      </p>
      <p>
        <label htmlFor="capture-observed-at">Observed at (ISO instant)</label>
        <input
          id="capture-observed-at"
          name="observedAt"
          value={values.observedAt}
          onChange={update('observedAt')}
          required
        />
      </p>
      <p>
        <label htmlFor="capture-observed-by">Observed by</label>
        <input
          id="capture-observed-by"
          name="observedBy"
          value={values.observedBy}
          onChange={update('observedBy')}
          required
        />
      </p>
      <button type="submit" disabled={pending}>
        {pending ? 'Capturing…' : 'Capture observation'}
      </button>
      {failure !== null ? <p role="alert">{failure}</p> : null}
      {outcome !== null ? <CommandOutcome outcome={outcome} /> : null}
    </form>
  );
}
