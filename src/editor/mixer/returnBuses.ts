import type { Analytics } from "../../analytics/analytics";
import type { RawCommandInput, TransactionResult } from "../../commands";
import { addReturn, addSend, removeReturn, removeSend } from "../../commands";
import type { Project, ReturnBus } from "../../domain/entities";
import {
  createReturnBus,
  createSend,
  type DomainFactoryContext,
} from "../../domain/factories";
import type { ReturnId, TrackId } from "../../domain/ids";
import { MAX_RETURN_BUSES } from "../../domain/parse";

/**
 * The editor's side of return buses and sends (#386): what a new return is
 * called, and the dispatches the mixer's return strips and send controls make.
 *
 * Nothing here mutates a project; every change is one command through the
 * host's dispatch. The `send_return` first use is logged the first time a
 * send is used: when adding one lands (here) or a send level commits (the
 * mixer), never for a return on its own.
 */

const RETURN_LETTERS = "ABCDEFGH";

export interface ReturnHost {
  project(): Project;
  dispatch(
    commands: RawCommandInput | readonly RawCommandInput[],
  ): TransactionResult | undefined;
  readonly analytics: Analytics;
}

/** The song's returns, in their order. */
export function sortedReturns(project: Project): ReturnBus[] {
  return [...project.song.returns].sort((a, b) => a.order - b.order);
}

/** "Return A", "Return B", …: the first letter no return is called yet. */
export function nextReturnName(returns: readonly ReturnBus[]): string {
  const taken = new Set(returns.map((bus) => bus.name));
  for (const letter of RETURN_LETTERS) {
    const name = `Return ${letter}`;
    if (!taken.has(name)) return name;
  }
  return `Return ${returns.length + 1}`;
}

/** Whether the song has room for another return. */
export function canAddReturn(project: Project): boolean {
  return project.song.returns.length < MAX_RETURN_BUSES;
}

/** Adds a return after the last one. Returns its id when it landed. */
export function addReturnBus(
  host: ReturnHost,
  context: DomainFactoryContext,
): ReturnId | undefined {
  const project = host.project();
  if (!canAddReturn(project)) return undefined;
  const returns = sortedReturns(project);
  const bus = createReturnBus(context, {
    name: nextReturnName(returns),
    order: returns.length,
  });
  const result = host.dispatch(addReturn(bus));
  return result?.ok ? bus.id : undefined;
}

/** Removes a return, and with it every send to it: one undoable transaction. */
export function deleteReturnBus(host: ReturnHost, returnId: ReturnId): void {
  host.dispatch(removeReturn(returnId));
}

/** Sends a track to a return, at the send level's declared default. */
export function sendTrackToReturn(
  host: ReturnHost,
  trackId: TrackId,
  returnId: ReturnId,
): void {
  const result = host.dispatch(addSend(trackId, createSend(returnId)));
  if (result?.ok) host.analytics.logFeatureFirstUse("send_return");
}

export function removeTrackSend(
  host: ReturnHost,
  trackId: TrackId,
  returnId: ReturnId,
): void {
  host.dispatch(removeSend(trackId, returnId));
}
