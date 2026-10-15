import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectFindings, defaultDetectors, maskAllAsync, maskAsync, nerDetector, unmask } from "../src/index.js";
import { fakeRecognize, fakeRecognizeAsync } from "./fake-ner.js";
import { groupByCategory, sortedExpected } from "./helpers.js";

/*
 * Golden fixtures that need an NER detector live in test/fixtures/ner/, so the
 * regex-only golden set (test/golden.test.ts, run with the synchronous API)
 * stays as it is. Each one runs twice: regex only (documents the gap) and
 * with nerDetector over a stub recognizer (closes it).
 */
interface NerFixture {
  file: string;
  name: string;
  text: string;
  nerNames: string[];
  expected: Record<string, string[]>;
  expectedWithoutNer: Record<string, string[]>;
}

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ner");
const fixtures: NerFixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((file) => ({ file, ...(JSON.parse(readFileSync(join(DIR, file), "utf8")) as Omit<NerFixture, "file">) }));

describe("NER golden set", () => {
  it("has at least one fixture", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(1);
  });

  describe.each(fixtures)("$file", (fx) => {
    it("regex only (sync API): misses the uncued names", () => {
      expect(groupByCategory(collectFindings(fx.text))).toEqual(sortedExpected(fx.expectedWithoutNer));
    });

    it("with an async NER detector: detects exactly the expected PII by category", async () => {
      const detectors = [...defaultDetectors(), nerDetector({ recognize: fakeRecognizeAsync(fx.nerNames) })];
      const { masked, findings, vault } = await maskAsync(fx.text, { detectors });
      expect(groupByCategory(findings)).toEqual(sortedExpected(fx.expected));
      for (const value of Object.values(fx.expected).flat()) {
        expect(masked, `${fx.file}: ${JSON.stringify(value)}`).not.toContain(value);
      }
      expect(unmask(masked, vault).warnings).toEqual([]);
    });

    it("a sync recognizer through maskAllAsync gives the same findings", async () => {
      const detectors = [...defaultDetectors(), nerDetector({ recognize: fakeRecognize(fx.nerNames) })];
      const { findings } = await maskAllAsync([fx.text], { detectors });
      expect(groupByCategory(findings.flat())).toEqual(sortedExpected(fx.expected));
    });
  });
});
