import { describe, expect, it } from "vitest";
import { collectFindings, mask } from "../src/index.js";
import { groupByCategory, loadFixtures, sortedExpected } from "./helpers.js";

const fixtures = loadFixtures();

describe("golden set", () => {
  it("has 6-9 fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    expect(fixtures.length).toBeLessThanOrEqual(9);
  });

  describe.each(fixtures)("$file", (fx) => {
    it("detects exactly the expected PII by category", () => {
      expect(groupByCategory(collectFindings(fx.text))).toEqual(sortedExpected(fx.expected));
    });

    it("leaves no expected value in the masked text", () => {
      const { masked } = mask(fx.text);
      for (const value of Object.values(fx.expected).flat()) {
        expect(masked, `${fx.file}: ${JSON.stringify(value)}`).not.toContain(value);
      }
    });
  });
});
