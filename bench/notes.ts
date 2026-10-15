/**
 * Benchmark inputs. Every value is fabricated: 555-01xx phone numbers,
 * example.* domains, the voided SSN 078-05-1120, the Visa test card
 * 4111 1111 1111 1111, synthetic VINs with valid check digits and invented
 * names. Nothing here belongs to a real person.
 */

interface Party {
  insured: string;
  first: string;
  claimant: string;
  adjuster: string;
  email: string;
  phone: string;
  altPhone: string;
  claim: string;
}

const PARTIES: readonly Party[] = [
  {
    insured: "Maria Gonzalez",
    first: "Maria",
    claimant: "Tomasz Kowalski",
    adjuster: "Priya Raman",
    email: "maria.gonzalez@example.com",
    phone: "(512) 555-0198",
    altPhone: "512-555-0142",
    claim: "CLM-88412",
  },
  {
    insured: "Daniel Whitfield",
    first: "Daniel",
    claimant: "Angela Brooks",
    adjuster: "Owen Castellano",
    email: "d.whitfield@example.org",
    phone: "(210) 555-0177",
    altPhone: "210-555-0151",
    claim: "CLM-90217",
  },
  {
    insured: "Renée Duchamp",
    first: "Renée",
    claimant: "Luis Ortega",
    adjuster: "Hannah Lindqvist",
    email: "renee.duchamp@example.net",
    phone: "(469) 555-0123",
    altPhone: "469.555.0188",
    claim: "CLM-91530",
  },
  {
    insured: "Kevin Osei",
    first: "Kevin",
    claimant: "Margaret Ellison",
    adjuster: "Farid Haddad",
    email: "kevin.osei@example.com",
    phone: "(214) 555-0133",
    altPhone: "214-555-0109",
    claim: "CLM-92004",
  },
  {
    insured: "Siobhan Byrne",
    first: "Siobhan",
    claimant: "Andrés Molina",
    adjuster: "Grace Whitaker",
    email: "s.byrne@example.org",
    phone: "(972) 555-0161",
    altPhone: "972-555-0116",
    claim: "CLM-93388",
  },
];

/** ~2 KB adjuster note for one claim. */
function claimNote(p: Party): string {
  return [
    `CLAIM NOTE 2024-06-11 — Claim # ${p.claim} — Policy No. PA-2024-0047731 (personal auto).`,
    `Insured: ${p.insured}, DOB: 03/14/1979. SSN on file: 078-05-1120 (verified against application).`,
    `Insured called from ${p.phone} at 09:42 to report a rear-end collision on I-35 northbound near exit 238. Date of loss 06/09/2024, approx. 17:15, clear weather, dry pavement.`,
    `Vehicle: 2003 Honda Accord EX, VIN 1HGCM82633A004352, garaged at 1290 Elm Street, San Antonio, TX 78209. Driver's license # TX12345678.`,
    `${p.insured} states the insured vehicle was stopped in traffic when a white pickup struck the rear bumper. The other driver exchanged no information and left the scene. Police report requested from the city; reference number pending.`,
    `Third-party claimant: ${p.claimant} (passenger in insured vehicle) reports neck stiffness, was seen at urgent care the same evening and released. Medical authorization form mailed. Claimant contact: ${p.altPhone}.`,
    `Recorded statement taken from the insured by phone (14 min); transcript attached to the file. Independent witness Dr. Alan Pierce, who was two cars back, confirmed the pickup did not stop.`,
    `Rental: insured has rental coverage at $35/day, 30-day max. Reserved a compact through the preferred vendor, pickup 06/12. Deductible $500 applies to collision.`,
    `Payment: insured asked whether the deductible can be charged to card 4111 1111 1111 1111; advised that deductibles are withheld from the settlement, not charged.`,
    `Photos received by email from ${p.email}: rear bumper, trunk lid, left tail lamp. Estimate requested from the direct repair shop; appraiser to inspect 06/13.`,
    `Coverage confirmed: collision, UM/UIM, PIP. No prior losses in 36 months. Subrogation potential low unless the other driver is identified; flagged for SIU review as hit-and-run.`,
    `Next steps: follow up with ${p.first} on the police report by 06/14, confirm repair shop selection, and document the claimant's medical treatment. Adjuster: ${p.adjuster}.`,
  ].join("\n");
}

/** ~300 B note. */
export const SMALL_NOTE =
  "Insured: Maria Gonzalez, DOB: 03/14/1979. Called from (512) 555-0198 about claim CLM-88412. " +
  "VIN 1HGCM82633A004352. Photos sent from maria.gonzalez@example.com. SSN on file 078-05-1120. " +
  "Asked to pay deductible with card 4111 1111 1111 1111; advised it is withheld from settlement.";

/** ~2 KB note. */
export const MEDIUM_NOTE = claimNote(PARTIES[0] as Party);

/** ~10 KB: five claim notes with different parties, as in a batch summary prompt. */
export const LARGE_NOTE = PARTIES.map(claimNote).join("\n\n---\n\n");

const SYSTEM_PROMPT =
  "You are a claims assistant for a personal-lines auto carrier. Summarise adjuster notes for the file, " +
  "list open action items with owners and due dates, and flag coverage questions. Use the lookup_client " +
  "tool when you need policyholder contact details. Never invent facts that are not in the notes.";

const CRM_TOOL_RESULT =
  '{"client":{"name":"Mr. Kevin Osei","email":"kevin.osei@example.com","phone":"(214) 555-0133",' +
  '"dob":"DOB 12/01/1990","ssn":"SSN 078-05-1120"},"policies":[{"policy":"Policy # 2024-AUTO-55810",' +
  '"vin":"1GNEK13Z92R000777"}]}';

export interface BenchBlock {
  type: string;
  [key: string]: unknown;
}

export interface BenchParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: string; content: string | BenchBlock[] }[];
  stream?: boolean;
}

/**
 * A realistic request: system prompt + 3 messages (user note, assistant
 * tool call, user tool_result + follow-up).
 */
export const REQUEST: BenchParams = {
  model: "claude-bench",
  max_tokens: 1024,
  system: SYSTEM_PROMPT,
  messages: [
    { role: "user", content: `Summarise this note for the claim file:\n\n${MEDIUM_NOTE}` },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I'll look up the policyholder record first." },
        { type: "tool_use", id: "toolu_bench_1", name: "lookup_client", input: { claim: "CLM-88412" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_bench_1", content: CRM_TOOL_RESULT },
        { type: "text", text: "Also draft a short email to Kevin Osei confirming the rental reservation." },
      ],
    },
  ],
};

/** The same strings, in the order the wrapper collects them, for maskAll. */
export const REQUEST_TEXTS: readonly string[] = [
  SYSTEM_PROMPT,
  `Summarise this note for the claim file:\n\n${MEDIUM_NOTE}`,
  "I'll look up the policyholder record first.",
  "CLM-88412",
  CRM_TOOL_RESULT,
  "Also draft a short email to Kevin Osei confirming the rental reservation.",
];

/**
 * A model reply referencing `tokens` (pass ~10). Built from placeholders so
 * it holds no values itself.
 */
export function replyWith(tokens: readonly string[]): string {
  const t = (i: number): string => tokens[i % tokens.length] ?? "";
  return [
    `Summary for the file: ${t(0)} (DOB ${t(1)}) reported a rear-end collision on 06/09/2024.`,
    `The insured vehicle (VIN ${t(2)}) is garaged at ${t(3)}; the other driver left the scene.`,
    `Passenger ${t(4)} was seen at urgent care; contact ${t(5)}.`,
    `Insured reachable at ${t(6)} or ${t(7)}. SSN ${t(8)} verified.`,
    `Action items: ${t(9)} to follow up on the police report by 06/14 and confirm the repair shop.`,
  ].join("\n");
}
