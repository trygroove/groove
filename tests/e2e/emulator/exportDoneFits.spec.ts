import { newProject } from "./support/assistant";
import { expect, test } from "./support/test";

/**
 * GRV-155: the Export complete screen keeps the height of the (shorter) export
 * panel, so on a one-track project its closing text was clipped with no way to
 * scroll to it. The whole screen has to be inside the dialog, however few tracks.
 */
test.describe("Export complete screen", () => {
  test("shows its closing text inside the dialog for a one-track project", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await newProject(page);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export" });
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    await expect(dialog.getByText("Export complete")).toBeVisible({ timeout: 60_000 });

    const closing = dialog.getByText("Exporting changed nothing");
    await expect(closing).toBeVisible();
    const fits = await page.evaluate(() => {
      const shell = document.querySelector(".export-shell")?.getBoundingClientRect();
      const text = document.querySelector(".export-next")?.getBoundingClientRect();
      if (!shell || !text) throw new Error("done screen missing");
      return { shellBottom: shell.bottom, textBottom: text.bottom };
    });
    expect(fits.textBottom).toBeLessThanOrEqual(fits.shellBottom + 0.5);
  });
});
