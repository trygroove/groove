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
 * GRV-167: the fixed release badge was drawn over a short Export dialog's own
 * text because it sat above every dialog scrim. A modal covers page chrome, so
 * the badge has to stack under every dialog backdrop.
 */
describe("release badge stacking", () => {
  const badge = zIndexOf(read("ReleaseBadge.css"), ".release-badge");

  it("sits under the shared dialog backdrop", () => {
    expect(badge).toBeLessThan(zIndexOf(read("Dialog.css"), ".dialog-backdrop"));
  });

  it("sits under the confirm dialog backdrop", () => {
    expect(badge).toBeLessThan(
      zIndexOf(read("ConfirmDialog.css"), ".confirm-dialog-backdrop"),
    );
  });
});
