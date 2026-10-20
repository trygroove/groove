import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(__dirname, name), "utf8");

const zIndexOf = (css: string, selector: string): number => {
  const block = css.match(
    new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`),
  );
  const value = block?.[1].match(/z-index:\s*(\d+)/);
  if (!value) throw new Error(`no z-index on ${selector}`);
  return Number(value[1]);
};

/**
 * GRV-182: the footer Privacy panel (the telemetry disclosure) was drawn over
 * the Keyboard shortcuts dialog and its scrim, because it sat at 1000, above
 * every dialog. It is page chrome, so it has to stack under every dialog
 * backdrop, as the release badge does (GRV-167).
 */
describe("telemetry disclosure stacking", () => {
  const disclosure = zIndexOf(read("TelemetryDisclosure.css"), ".telemetry-disclosure");

  it("sits under the shared dialog backdrop", () => {
    expect(disclosure).toBeLessThan(zIndexOf(read("Dialog.css"), ".dialog-backdrop"));
  });

  it("sits under the confirm dialog backdrop", () => {
    expect(disclosure).toBeLessThan(
      zIndexOf(read("ConfirmDialog.css"), ".confirm-dialog-backdrop"),
    );
  });
});
