import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Detector, Finding } from "../src/index.js";

export interface Fixture {
  file: string;
  name: string;
  text: string;
  expected: Record<string, string[]>;
}

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, ...(JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as Omit<Fixture, "file">) }));
}

export function values(detector: Detector, text: string): string[] {
  return detector.detect(text).map((f: Finding) => f.value);
}

export function groupByCategory(findings: readonly Pick<Finding, "category" | "value">[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of findings) (out[f.category] ??= []).push(f.value);
  for (const list of Object.values(out)) list.sort();
  return out;
}

export function sortedExpected(expected: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, [...v].sort()]));
}
