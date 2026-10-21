import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { onTestFinished, vi } from "vitest";
import { Analytics } from "../../analytics/analytics";
import { ConsentStore } from "../../analytics/consent";
import { createRecordingTransport } from "../../analytics/transport";
import { noteEventsOf } from "../../commands";
import type { NoteEvent } from "../../domain/entities";
import { createPianoRollFixtureProject } from "../../domain/fixtures";
import { createInMemoryProjectRepository } from "../../persistence/inMemoryProjectRepository";
import { createManualClock } from "../../shared/clock";
import { memoryStorage } from "../../testing/storage";
import { EditorSession } from "../composition/EditorSession";
import PianoRoll, { type PianoRollProps } from "./PianoRoll";

/**
 * A piano roll over a real `EditorSession` (test-only): every edit runs the
 * command layer and its undo history. The fixture clip is two bars of C3, E3,
 * G3 and C4, a step each, on steps 1, 5, 9 and 13.
 */
export async function setUpRoll(options: { analyticsEnabled?: boolean } = {}) {
  const repository = createInMemoryProjectRepository();
  const project = createPianoRollFixtureProject();
  const created = await repository.createProject(project);
  if (!created.ok) throw new Error("fixture failed to create");

  const transport = createRecordingTransport();
  const consent = new ConsentStore(memoryStorage());
  if (options.analyticsEnabled === false) consent.optOut();
  const analytics = new Analytics({ transport, consent, storage: memoryStorage() });
  analytics.setAccountType("anonymous");
  const session = new EditorSession({
    repository,
    project,
    clock: createManualClock(1_000),
    analytics,
    deviceStorage: memoryStorage(),
  });

  const [live, setLive] = createSignal(session.project);
  onTestFinished(session.subscribe(() => setLive(session.project)));
  const audition = vi.fn();

  function renderRoll(extra: Partial<PianoRollProps> = {}) {
    return render(() => (
      <PianoRoll
        clip={live().clips[0]}
        project={live()}
        dispatch={session.dispatch.bind(session)}
        beginGesture={session.beginGesture.bind(session)}
        audition={audition}
        analytics={analytics}
        {...extra}
      />
    ));
  }

  function notes(): readonly NoteEvent[] {
    return noteEventsOf(session.project.clips[0]) ?? [];
  }

  function events(name: string) {
    return transport.events.filter((event) => event.name === name);
  }

  return { session, audition, renderRoll, notes, events };
}
