/**
 * Every value in these notes is fictional. Each kind of identifier comes from
 * a range or a number that is publicly reserved for examples, so nothing here
 * can belong to a real person (see FAKE_DATA_SOURCES).
 */
export interface Sample {
  id: string;
  title: string;
  kind: string;
  text: string;
  /** Shown under the sample when it demonstrates something specific. */
  note?: string;
}

export const SAMPLES: readonly Sample[] = [
  {
    id: "auto-claim",
    title: "Auto claim note",
    kind: "Adjuster note",
    text: `CLAIM NOTE — Claim # CLM-20417 — Policy No. 512-555-0147 (personal auto)
Insured: Dana Whitfield, DOB: 04/22/1986. Driver's license # TX40917355.
Insured called from (512) 555-0123 to report a rear-end collision on I-35. Vehicle: 2003 Honda Accord, VIN 1HGCM82633A004352.
Dana Whitfield says the other driver left the scene. Whitfield asked that updates go to dana.whitfield@example.com.`,
  },
  {
    id: "workers-comp",
    title: "Workers' comp intake",
    kind: "Intake form",
    text: `WORKERS' COMP FIRST REPORT — Claim # WC-77310
Claimant: Marcus Oyelaran
SSN: 078-05-1120   Date of birth: 11/03/1979
Home address: 742 Evergreen Terrace, Springfield, OR 97477
Phone: (503) 555-0187
Injury: lower back strain lifting inventory. Marcus Oyelaran was seen at urgent care the same day and is off work for 5 days.`,
  },
  {
    id: "renewal-email",
    title: "Policy renewal email",
    kind: "Customer email",
    text: `From: priya.natarajan@example.org
Subject: Renewal payment for policy HO-55120

Policyholder: Priya Natarajan
Please charge the renewal to my card 4111 1111 1111 1111 and send the receipt to this address.
You can reach me at (415) 555-0142 after 5pm.
Thanks, Priya Natarajan`,
  },
  {
    id: "crm-tool-result",
    title: "CRM lookup (tool result)",
    kind: "System record",
    text: `{"record":"CUST-48201","name":"Tomasz Kowalski","contact":"tomasz.k@example.net","phone":"(212) 555-0164","dob":"DOB 07/19/1990","notes":"Contact: Tomasz Kowalski. Kowalski prefers email. Account 4471-2290 in good standing."}`,
  },
  {
    id: "known-gaps",
    title: "Known gaps",
    kind: "Limitations",
    note: "Regex detection needs a cue. A name with no label or title, typed in lowercase, and a 7-digit phone number with no area code are not caught. Catching them needs an NER model, which the Detector interface is built to plug in.",
    text: `Spoke with jordan ellery about the hail damage. jordan said the roofer will call back from 555-0139 tomorrow.
Insured: Riley Ashworth confirmed the same.`,
  },
];

export interface FakeDataSource {
  kind: string;
  why: string;
}

/** Shown in the "Why this data is fake" panel. */
export const FAKE_DATA_SOURCES: readonly FakeDataSource[] = [
  { kind: "Names", why: "Invented for this demo." },
  { kind: "Phone numbers", why: "555-0100 to 555-0199 is reserved for fictional use by the North American Numbering Plan." },
  { kind: "Email addresses", why: "example.com, .org and .net are reserved for documentation (RFC 2606)." },
  { kind: "SSN 078-05-1120", why: "Printed on a sample card sold in wallets in 1938 and voided by the Social Security Administration." },
  { kind: "Card 4111 1111 1111 1111", why: "The standard Visa test number used by payment processors." },
  { kind: "VIN 1HGCM82633A004352", why: "A widely published example VIN with a valid check digit." },
  { kind: "742 Evergreen Terrace", why: "The Simpsons' address." },
  { kind: "Dates of birth, license, claim and policy numbers", why: "Made up." },
];

export function findSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}
