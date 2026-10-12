/**
 * Fails the hosted-build run (`playwright.hosting.config.ts`) if any page
 * broke the Content-Security-Policy (GRV-7).
 *
 * `tests/e2e/support/hostingServer.mjs` keeps every violation report the
 * browser sends it, except the one `csp.hosting.ts` plants on purpose. A refused
 * script, style, frame or request is a feature that silently does not work in
 * production, whether or not the test that caused it noticed.
 */
export default async function noViolations(): Promise<void> {
  const response = await fetch("http://127.0.0.1:3200/__csp-reports");
  const reports = (await response.json()) as unknown[];
  if (reports.length > 0) {
    throw new Error(
      `The app broke its Content-Security-Policy ${reports.length} time(s):\n` +
        reports.map((report) => JSON.stringify(report)).join("\n"),
    );
  }
}
