import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { onTestFinished as onTestCleanup } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import {
  createRecordingTransport,
  type RecordingTransport,
} from "../../analytics/transport";
import { noteEventsOf } from "../../commands";
import type { NoteEvent } from "../../domain/entities";
import { createPianoRollFixtureProject } from "../../domain/fixtures";
import type { EventId } from "../../domain/ids";
import { createInMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { createManualClock } from "../../shared/clock";
import { memoryStorage } from "../../testing/storage";
import { EditorSession } from "../composition/EditorSession";
import TransformPanel from "./TransformPanel";

/**
 * Shared harness for the `TransformPanel` suites (test-only): a real
 * `EditorSession` over an in-memory repository, so a transformation goes
 * through the actual command layer, transaction, and undo history rather than
 * a stub, and one recording transport shared by the session and the panel, so
 * a test can assert the whole event stream a user action produced.
 */
export async function setUpTransformPanel(options: { analyticsEnabled?: boolean } = {}) {
  const repository = createInMemoryProjectRepository();
  const project = createPianoRollFixtureProject();
  const created = await repository.createProject(project);
  if (!created.ok) throw new Error("fixture failed to create");

  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  if (options.analyticsEnabled === false) consent.optOut();

  const session = new EditorSession({
    repository,
    project,
    clock: createManualClock(1_000),
    analytics: new Analytics({ transport, consent, storage: memoryStorage() }),
    deviceStorage: memoryStorage(),
  });

  const panelAnalytics = new Analytics({
    transport,
    consent,
    storage: memoryStorage(),
  });
  panelAnalytics.setAccountType("anonymous");

  // The panel's props must track the session the way `EditorView` does, or a
  // test cannot see anything that depends on the project changing underneath
  // (an undo, a remote edit). `session.subscribe` is the same signal the real
  // editor re-renders from.
  const [live, setLive] = createSignal(session.project);
  const unsubscribe = session.subscribe(() => setLive(session.project));
  onTestCleanup(unsubscribe);

  function renderPanel(selectedIds: readonly EventId[] = []) {
    return render(() => (
      <TransformPanel
        clip={live().clips[0]}
        project={live()}
        selectedIds={selectedIds}
        dispatch={session.dispatch.bind(session)}
        editor="piano_roll"
        analytics={panelAnalytics}
      />
    ));
  }

  return { repository, session, transport, renderPanel };
}

export function currentNotes(session: EditorSession): readonly NoteEvent[] {
  return noteEventsOf(session.project.clips[0]) ?? [];
}

export function pitchOf(event: NoteEvent): number {
  return event.trigger.kind === "pitch" ? event.trigger.pitch : -1;
}

export function pitches(session: EditorSession): number[] {
  return currentNotes(session)
    .map(pitchOf)
    .sort((a, b) => a - b);
}

/** The `(startTicks, velocity)` pairs a seeded-variation assertion compares. */
export function rhythmOf(session: EditorSession): [number, number][] {
  return currentNotes(session).map((event) => [event.startTicks, event.velocity]);
}

export function clipEdited(transport: RecordingTransport) {
  return transport.events.filter((event) => event.name === "clip_edited");
}

/**
 * Clicks the panel button whose visible label is `label`.
 *
 * Every helper here ends with `flush()`. In a browser each event is its own
 * task, so Solid 2 has applied the handler's writes before the next thing a
 * user does; `fireEvent` dispatches synchronously, so without the flush a
 * following click would read the options — or an assertion would read the
 * error text — as they stood before.
 */
export function clickTransform(label: string): void {
  const button = screen
    .getAllByRole("button")
    .find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`no ${label} button`);
  fireEvent.click(button);
  flush();
}

/** Types into one of the panel's labelled value fields and commits it. */
export function setOption(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label, { exact: false }), {
    target: { value },
  });
  flush();
}
