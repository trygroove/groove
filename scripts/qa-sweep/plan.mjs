#!/usr/bin/env node
/**
 * Plan one QA sweep run (#859): resolve the budget and pick the flows.
 *
 *   node scripts/qa-sweep/plan.mjs
 *
 * Reads, from the environment:
 *   QA_SWEEP_AGENTS_INPUT, QA_SWEEP_AGENTS_VAR   the agent cap (dispatch input, then repo variable)
 *   QA_SWEEP_ISSUES_INPUT, QA_SWEEP_ISSUES_VAR   the new-issue cap, the same way
 *   QA_SWEEP_FLOWS                                optional flow IDs to walk instead of the rotation
 *
 * Writes `flows` (a JSON array, one matrix entry per agent, each with the
 * agent's QA account `slot`), `agents` and
 * `issues` to $GITHUB_OUTPUT when it is set, and prints the plan either way.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_AGENTS,
  DEFAULT_ISSUES,
  MAX_AGENTS,
  MAX_ISSUES,
  parseFlowList,
  parseFlows,
  pickFlows,
  resolveLimit,
} from "./sweep.mjs";

const REGISTER = "docs/core-flows.md";
const SUITE = "tests/e2e/emulator/flows";

/** Every registered flow, with whether its spec is still parked at `test.fixme`. */
export function loadFlows(root = ".") {
  const register = readFileSync(join(root, REGISTER), "utf8");
  const specs = new Map();
  for (const [, id] of register.matchAll(/^### (CF-\d{3}) — /gm)) {
    const path = join(root, SUITE, `${id}.spec.ts`);
    if (existsSync(path)) specs.set(id, readFileSync(path, "utf8"));
  }
  return parseFlows(register, specs);
}

export function plan(env, { root = ".", date = new Date() } = {}) {
  const agents = resolveLimit([env.QA_SWEEP_AGENTS_INPUT, env.QA_SWEEP_AGENTS_VAR], {
    fallback: DEFAULT_AGENTS,
    ceiling: MAX_AGENTS,
    min: 1,
    name: "agents",
  });
  const issues = resolveLimit([env.QA_SWEEP_ISSUES_INPUT, env.QA_SWEEP_ISSUES_VAR], {
    fallback: DEFAULT_ISSUES,
    ceiling: MAX_ISSUES,
    name: "issues",
  });
  // Each agent gets its own QA account, `testuser<slot>` (#1055): slots 1 to
  // MAX_AGENTS, which is why the pool (`scripts/access/qaPool.ts`) has ten
  // sweep accounts. Separate accounts keep agents out of each other's
  // projects, so each one's cleanup deletes only its own.
  const flows = pickFlows({
    flows: loadFlows(root),
    count: agents,
    date,
    requested: parseFlowList(env.QA_SWEEP_FLOWS),
  }).map((flow, index) => ({ ...flow, slot: index + 1 }));
  return { agents, issues, flows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = plan(process.env);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `flows=${JSON.stringify(result.flows)}\nagents=${result.agents}\nissues=${result.issues}\n`,
    );
  console.log(
    `QA sweep: ${result.flows.length} agent(s), up to ${result.issues} new issue(s).\n` +
      result.flows
        .map((f) => `  ${f.id} ${f.title}${f.parked ? " (parked)" : ""}`)
        .join("\n"),
  );
}
