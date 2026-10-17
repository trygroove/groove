import { describe, expect, it } from "vitest";
import * as zod from "zod";
import viteConfig from "../vite.config";
import zodConfigDefault, * as configured from "./zodConfig";

// The client's Zod (GRV-7): see `src/zodConfig.ts` for why the config is
// Zod's own entry point rather than a side-effect import in `app.tsx`.
describe("the client's Zod", () => {
  it("is aliased from bare `zod` in the Vite config", () => {
    const alias = viteConfig.resolve?.alias;
    expect(Array.isArray(alias)).toBe(true);
    const entry = (alias as { find: string | RegExp; replacement: string }[]).find(
      ({ find }) => find instanceof RegExp && find.test("zod"),
    );
    expect(entry?.replacement).toMatch(/\/src\/zodConfig\.ts$/);
    expect((entry?.find as RegExp).test("zod/v4")).toBe(false);
  });

  it("turns off the `new Function` probe", () => {
    expect(configured.z.config().jitless).toBe(true);
  });

  it("exports what `zod` exports, from the same build", () => {
    expect(configured.z.object).toBe(zod.z.object);
    expect(zodConfigDefault).toBe(configured.z);
    for (const name of Object.keys(zod)) {
      expect(configured, name).toHaveProperty(name);
    }
  });
});
