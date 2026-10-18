// A job only sees `prod` environment secrets if it declares `environment: prod`;
// without it the secret expands to the empty string (GRV-118).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOWS = join(import.meta.dirname, "..", ".github", "workflows");
const PROD_SECRETS = ["QA_SIGN_IN_SERVICE_ACCOUNT"];

/** Splits a workflow into its jobs by indentation: `jobs:` then `  <id>:`. */
function jobsOf(text) {
  const afterJobs = text.split(/^jobs:\s*$/m)[1] ?? "";
  const parts = afterJobs.split(/^ {2}([\w-]+):\s*$/m);
  const jobs = [];
  for (let i = 1; i < parts.length; i += 2)
    jobs.push({ id: parts[i], body: parts[i + 1] });
  return jobs;
}

describe("jobs that read a prod environment secret", () => {
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))) {
    for (const { id, body } of jobsOf(readFileSync(join(WORKFLOWS, file), "utf8"))) {
      for (const secret of PROD_SECRETS) {
        if (!body.includes(`secrets.${secret}`)) continue;
        it(`${file} job ${id} declares environment: prod for ${secret}`, () => {
          expect(body).toMatch(/^ {4}environment:\s*prod\s*$/m);
        });
      }
    }
  }
});
