import { describe, expect, it } from "vitest";
import { COMPOSER_MAX_LINES, composerHeight, fitComposer } from "./composerHeight";

describe("composerHeight (GRV-115)", () => {
  it("follows the text while it is under ten lines", () => {
    expect(composerHeight(58, 21, 16)).toBe(58);
    expect(composerHeight(16 + 21 * 5, 21, 16)).toBe(121);
  });

  it("stops growing at ten lines and leaves the rest to scroll", () => {
    expect(COMPOSER_MAX_LINES).toBe(10);
    expect(composerHeight(16 + 21 * 30, 21, 16)).toBe(16 + 21 * 10);
  });
});

describe("fitComposer", () => {
  function composer(scrollHeight: number): HTMLTextAreaElement {
    const element = document.createElement("textarea");
    element.style.lineHeight = "21px";
    element.style.paddingTop = "8px";
    element.style.paddingBottom = "8px";
    document.body.append(element);
    Object.defineProperty(element, "scrollHeight", { value: scrollHeight });
    return element;
  }

  it("sizes the textarea to its content", () => {
    const element = composer(100);
    fitComposer(element);
    expect(element.style.height).toBe("100px");
    element.remove();
  });

  it("caps the textarea at ten lines", () => {
    const element = composer(900);
    fitComposer(element);
    expect(element.style.height).toBe("226px");
    element.remove();
  });
});
