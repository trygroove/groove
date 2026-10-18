/**
 * An experiment's spend, and when it must stop (GRV-110).
 *
 * The tally sums each finished turn's estimated cost, from its provider usage
 * and the model's price (`ASSISTANT_MODELS`, as the scorecard prices a run).
 * A turn starts only while what is spent, plus what the turns in flight and
 * this one could cost at the dearest turn so far, stays inside the budget;
 * so the run stops *at* the budget rather than one batch past it. Until a
 * turn has reported, there is no cost to project from, and only the spend
 * itself is held to the budget.
 */
import type { AssistantModelProfile } from "../config";
import type { ProviderUsage } from "../streamEvents";
import { turnCostUsd } from "./scorecard";

export class SpendTally {
  #spentUsd = 0;
  #pricedTurns = 0;
  #dearestTurnUsd = 0;

  constructor(readonly budgetUsd: number) {
    if (!(budgetUsd > 0)) throw new RangeError("The budget must be more than $0");
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  /** The mean cost of a turn so far, or null before one has reported. */
  get meanTurnUsd(): number | null {
    return this.#pricedTurns === 0 ? null : this.#spentUsd / this.#pricedTurns;
  }

  /** Adds one finished turn: its cost in dollars, or null when it recorded no usage. */
  add(costUsd: number | null): void {
    if (costUsd === null) return;
    this.#spentUsd += costUsd;
    this.#pricedTurns += 1;
    this.#dearestTurnUsd = Math.max(this.#dearestTurnUsd, costUsd);
  }

  /** Adds a turn by its usage, priced for `model`. */
  addUsage(model: AssistantModelProfile, usage: ProviderUsage | null | undefined): void {
    this.add(usage ? turnCostUsd(model, usage) : null);
  }

  /** Whether one more turn may start while `inFlight` others are running. */
  canStart(inFlight: number): boolean {
    if (this.#spentUsd >= this.budgetUsd) return false;
    const projected = this.#spentUsd + (inFlight + 1) * this.#dearestTurnUsd;
    return projected <= this.budgetUsd;
  }
}
