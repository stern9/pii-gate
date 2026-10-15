/**
 * Plugging a named-entity model into pii-gate, with no network and no model:
 * `recognize` below is a stub with the same shape a real NER returns.
 * Run: npx tsx examples/ner.ts
 *
 * All names and numbers are fabricated.
 */
import {
  NerDetectorError,
  defaultDetectors,
  mask,
  maskAsync,
  nerDetector,
  unmask,
  wrapAnthropic,
  type CreateParamsLike,
  type MessageLike,
  type NerEntity,
  type NerRecognize,
} from "../src/index.js";

const note = `Claim # CLM-77120. Policy No. 512-555-0147.
spoke with jordan ellery at the body shop; estimate approved.
Claimant: Priya Natarajan, phone (512) 555-0143. Jordan Ellery will send photos.`;

function section(title: string): void {
  console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 60 - title.length))}`);
}

/*
 * 1. The stub. A real recognizer returns entities with a label, a score and
 *    either UTF-16 offsets, the entity text (`word`), or both.
 */
const recognize: NerRecognize = async (text) => {
  await new Promise((resolve) => setTimeout(resolve, 5)); // pretend inference
  const entities: NerEntity[] = [];
  for (const m of text.matchAll(/\bjordan ellery\b/gi)) {
    entities.push({ label: "PER", score: 0.94, start: m.index, end: m.index + m[0].length, word: m[0] });
  }
  return entities;
};

/*
 * 2. Real recognizers have the same shape. Two sketches (not run here, so this
 *    example has no dependencies):
 *
 * transformers.js, in-process (npm i @huggingface/transformers). Its
 * token-classification output is one item per sub-word token, e.g.
 * { entity: "B-PER", score: 0.99, word: "jo" }, { entity: "I-PER", word: "##rdan" },
 * often without offsets (check what your version returns). Join the tokens into
 * entity words and let nerDetector find them in the text:
 *
 *   import { pipeline } from "@huggingface/transformers";
 *   const ner = await pipeline("token-classification", "Xenova/bert-base-NER");
 *   const recognize: NerRecognize = async (text) => {
 *     const tokens = (await ner(text)) as { entity: string; score: number; word: string }[];
 *     const entities: { label: string; score: number; word: string }[] = [];
 *     for (const t of tokens) {
 *       const last = entities.at(-1);
 *       const label = t.entity.replace(/^[BI]-/, "");
 *       if (last && t.word.startsWith("##")) last.word += t.word.slice(2);          // same word
 *       else if (last && t.entity.startsWith("I-") && last.label === label) last.word += ` ${t.word}`; // next word
 *       else { entities.push({ label, score: t.score, word: t.word }); continue; }
 *       last.score = Math.min(last.score, t.score);
 *     }
 *     return entities; // word-only: every whole-word occurrence is masked
 *   };
 *   // Joining with spaces turns "Jean-Luc" into "Jean - Luc" and "O'Brien" into
 *   // "O ' Brien"; the search ignores punctuation between tokens, so these still
 *   // match. Never return a bare "##..." piece: it is rejected, not searched.
 *
 * (Python's transformers pipeline does this itself with
 * aggregation_strategy="simple" and returns character offsets.)
 *
 * An HTTP NER service (spaCy, a cloud NER API, your own model server):
 *
 *   const recognize: NerRecognize = async (text, { signal }) => {
 *     const res = await fetch("https://ner.internal.example/v1/entities", {
 *       method: "POST",
 *       headers: { "content-type": "application/json" },
 *       body: JSON.stringify({ text }),
 *       signal, // aborted when timeoutMs elapses
 *     });
 *     if (!res.ok) throw new Error(`NER service returned ${res.status}`); // status only, never the text
 *     const body = (await res.json()) as { ents: { label: string; start_char: number; end_char: number; text: string }[] };
 *     // spaCy labels people "PERSON"; offsets from Python are code points, so send `word` too.
 *     return body.ents.map((e) => ({ label: e.label, start: e.start_char, end: e.end_char, word: e.text }));
 *   };
 *
 * Both go into nerDetector exactly like the stub. Keep the model or service
 * inside your own trust boundary: it sees the unmasked text.
 */

const ner = nerDetector({
  recognize,
  minScore: 0.7, // default
  timeoutMs: 2000, // a slow model must not hang the request
  onError: "throw", // default: no NER, no request
  onFailure: (f) => console.warn(`[ner] ${f.detector} failed: ${f.reason}`), // reason only, never f.error's message
});
const detectors = [...defaultDetectors(), ner];

section("1. regex only (sync mask)");
console.log(mask(note).masked);

section("2. regex + NER (maskAsync)");
const { masked, vault, findings } = await maskAsync(note, { detectors });
console.log(masked);
console.log("\nfindings:", findings.map((f) => `${f.category}/${f.detector ?? "?"} -> ${f.token ?? "-"}`).join(", "));
console.log("\nrestored:", unmask("Send {{PERSON_1}} the rental form.", vault).text);

section("3. failing NER: the request is refused");
const down = nerDetector({
  recognize: async () => {
    throw new Error("connection refused");
  },
});
try {
  await maskAsync(note, { detectors: [...defaultDetectors(), down] });
} catch (err) {
  if (!(err instanceof NerDetectorError)) throw err;
  console.log(`${err.name}: reason=${err.reason}`);
}

section("4. wrapAnthropic with the NER detector");
type Block = { type: string; [key: string]: unknown };
interface Params extends CreateParamsLike {
  model: string;
  messages: { role: string; content: string | Block[] }[];
}
interface Message extends MessageLike {
  model: string;
  content: Block[];
}
/** Stands in for `new Anthropic()`; prints what would go over the wire. */
const fakeClient = {
  messages: {
    async create(params: Params): Promise<Message> {
      console.log("[model received]", JSON.stringify(params.messages[0]?.content));
      return { model: params.model, content: [{ type: "text", text: "Call {{PERSON_1}} about the photos." }] };
    },
  },
};
const gated = wrapAnthropic(fakeClient, { detectors });
const reply = await gated.messages.create({ model: "claude-example", messages: [{ role: "user", content: note }] });
console.log("[app received]", reply.content[0]?.["text"]);
