import { describe, expect, it } from "vitest";
import {
  addressDetector,
  creditCardDetector,
  detect,
  dobDetector,
  driversLicenseDetector,
  emailDetector,
  isValidVinCheckDigit,
  luhnValid,
  personDetector,
  phoneDetector,
  resolveOverlaps,
  ssnDetector,
  staticDetector,
  vinDetector,
  type Finding,
} from "../src/index.js";
import { values } from "./helpers.js";

describe("ssnDetector", () => {
  const d = ssnDetector();

  it("finds dashed, spaced and undashed SSNs", () => {
    expect(values(d, "SSN 123-45-6789")).toEqual(["123-45-6789"]);
    expect(values(d, "ssn 123 45 6789")).toEqual(["123 45 6789"]);
    expect(values(d, "SSN: 123456789")).toEqual(["123456789"]);
  });

  it("rejects never-issued areas, groups and serials", () => {
    for (const bad of ["000-12-3456", "666-12-3456", "900-12-3456", "987-65-4321", "123-00-4567", "123-45-0000"]) {
      expect(values(d, `SSN ${bad}`), bad).toEqual([]);
    }
  });

  it("rejects mixed separators and longer digit runs", () => {
    expect(values(d, "123-45 6789")).toEqual([]);
    expect(values(d, "1234567890")).toEqual([]);
    expect(values(d, "ref 123-45-67890")).toEqual([]);
  });

  it("scores an undashed run higher with an SSN cue", () => {
    const [cued] = d.detect("social security number 219099999");
    const [bare] = d.detect("219099999");
    expect(cued?.confidence).toBeGreaterThan(bare?.confidence ?? 1);
  });

  it("ignores SSN-shaped numbers labelled as account/policy identifiers", () => {
    expect(values(d, "Account # 078-05-1120")).toEqual([]);
    expect(values(d, "Policy number 219099999")).toEqual([]);
  });
});

describe("phoneDetector", () => {
  const d = phoneDetector();

  it("finds common US formats", () => {
    expect(values(d, "call (512) 555-0198")).toEqual(["(512) 555-0198"]);
    expect(values(d, "call 512-555-0198 now")).toEqual(["512-555-0198"]);
    expect(values(d, "cell 469.555.0142")).toEqual(["469.555.0142"]);
    expect(values(d, "+1 (972) 555-0161 ext 204")).toEqual(["+1 (972) 555-0161 ext 204"]);
    expect(values(d, "1-800-555-0110")).toEqual(["1-800-555-0110"]);
  });

  it("accepts a bare 10-digit run only after a phone cue", () => {
    expect(values(d, "Phone: 5125550198")).toEqual(["5125550198"]);
    expect(values(d, "ref 5125550198")).toEqual([]);
  });

  it("does not treat a policy/claim number as a phone", () => {
    expect(values(d, "Policy No. 512-555-0147")).toEqual([]);
    expect(values(d, "Claim # 512-555-0147")).toEqual([]);
    expect(values(d, "policy number: (512) 555-0147")).toEqual([]);
  });

  it("rejects invalid NANP area/exchange codes and embedded runs", () => {
    expect(values(d, "012-555-0198")).toEqual([]);
    expect(values(d, "512-055-0198")).toEqual([]);
    expect(values(d, "CLM-512-555-0198")).toEqual([]);
  });

  it("accepts international and short numbers directly after a phone label", () => {
    expect(values(d, "phone number: 55501234")).toEqual(["55501234"]);
    expect(values(d, "phone: +44 20 7946 0958")).toEqual(["+44 20 7946 0958"]);
    expect(values(d, "Tel. +44 (0)20 7946 0321")).toEqual(["+44 (0)20 7946 0321"]);
    expect(values(d, "Mobile: 07700 900461.")).toEqual(["07700 900461"]);
    expect(values(d, "contact number is +44 20 7946 0999")).toEqual(["+44 20 7946 0999"]);
    expect(values(d, "Phone #: 555.0123.4567")).toEqual(["555.0123.4567"]);
    expect(values(d, "mob - 0161 496 0000")).toEqual(["0161 496 0000"]);
  });

  it("scores labelled international numbers above the default cutoff but below US numbers", () => {
    const [f] = d.detect("phone: +44 20 7946 0958");
    expect(f?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(f?.confidence).toBeLessThan(0.85);
  });

  it("lets the US rule own US numbers after a label (one finding, US confidence)", () => {
    expect(d.detect("Phone: (512) 555-0198").map((f) => [f.value, f.confidence])).toEqual([["(512) 555-0198", 0.85]]);
    expect(d.detect("phone: +1 512-555-0198").map((f) => [f.value, f.confidence])).toEqual([["+1 512-555-0198", 0.85]]);
  });

  it("needs the label for non-US numbers", () => {
    expect(values(d, "ref 55501234")).toEqual([]);
    expect(values(d, "Contact 55501234")).toEqual([]);
    expect(values(d, "cellular 5550123")).toEqual([]);
    expect(values(d, "+44 20 7946 0958")).toEqual([]);
  });

  it("does not take words, counts, dates or the next line after a phone label", () => {
    expect(values(d, "phone: call after 5pm")).toEqual([]);
    expect(values(d, "phone 2 of 3")).toEqual([]);
    expect(values(d, "phone: 12-05-2024")).toEqual([]);
    expect(values(d, "Phone:\nClaim # 55501234")).toEqual([]);
    expect(values(d, "Phone: 555 0123\nCLM 4455")).toEqual(["555 0123"]);
    expect(values(d, "phone: 55501234 06/09/2024")).toEqual(["55501234"]);
    expect(values(d, "phone: 55501234 2024-06-01")).toEqual(["55501234"]);
    expect(values(d, "Phone #: +44 20 7946 0123 on 2024-06-01")).toEqual(["+44 20 7946 0123"]);
    expect(values(d, "Phone: 55501234, CLM-88412")).toEqual(["55501234"]);
    expect(values(d, "phone: 555 0123 5pm")).toEqual(["555 0123"]);
    expect(values(d, "phone: 1234567890123456")).toEqual([]);
  });

  it("still skips identifier-labelled numbers near a phone label", () => {
    expect(values(d, "Policy No. 512-555-0147")).toEqual([]);
    expect(values(d, "Phone/Policy No. 55501234")).toEqual([]);
  });
});

describe("emailDetector", () => {
  const d = emailDetector();

  it("finds emails including plus-addressing and subdomains", () => {
    expect(values(d, "to maria.gonzalez+claims@mail.example.co.uk.")).toEqual(["maria.gonzalez+claims@mail.example.co.uk"]);
  });

  it("ignores handles and bare domains", () => {
    expect(values(d, "@maria and example.com and user@localhost")).toEqual([]);
  });
});

describe("vinDetector", () => {
  const d = vinDetector();

  it("validates the check digit", () => {
    expect(isValidVinCheckDigit("1HGCM82633A004352")).toBe(true);
    expect(isValidVinCheckDigit("1HGCM82643A004352")).toBe(false);
    expect(isValidVinCheckDigit("1M8GDM9AXKP042788")).toBe(true); // check digit X
  });

  it("finds a valid VIN", () => {
    expect(values(d, "VIN: 1HGCM82633A004352.")).toEqual(["1HGCM82633A004352"]);
  });

  it("rejects a VIN containing I, O or Q", () => {
    expect(values(d, "VIN 1HGCM8263IA004352")).toEqual([]);
    expect(values(d, "VIN 1HGCM82633O004352")).toEqual([]);
  });

  it("rejects a 17-char string with a bad check digit by default, and accepts it at low confidence when relaxed", () => {
    expect(values(d, "VIN 1HGCM82643A004352")).toEqual([]);
    const [relaxed] = vinDetector({ requireCheckDigit: false }).detect("VIN 1HGCM82643A004352");
    expect(relaxed?.confidence).toBeLessThan(0.9);
  });

  it("rejects lowercase and embedded runs", () => {
    expect(values(d, "1hgcm82633a004352")).toEqual([]);
    expect(values(d, "X1HGCM82633A004352")).toEqual([]);
  });
});

describe("creditCardDetector", () => {
  const d = creditCardDetector();

  it("finds Luhn-valid numbers with spaces, dashes or no separators", () => {
    expect(values(d, "4111 1111 1111 1111")).toEqual(["4111 1111 1111 1111"]);
    expect(values(d, "4111-1111-1111-1111")).toEqual(["4111-1111-1111-1111"]);
    expect(values(d, "5500000000000004")).toEqual(["5500000000000004"]);
    expect(values(d, "amex 3782 822463 10005")).toEqual(["3782 822463 10005"]);
  });

  it("rejects a 16-digit number that fails Luhn", () => {
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(values(d, "invoice 4111111111111112")).toEqual([]);
  });

  it("rejects too-short numbers and leading digits outside major networks", () => {
    expect(values(d, "411111111111")).toEqual([]);
    expect(values(d, "0000000000000000")).toEqual([]);
  });

  it("accepts the standard groupings", () => {
    expect(values(d, "diners 3056 930902 5904")).toEqual(["3056 930902 5904"]);
    expect(values(d, "4111-1111-1111-1111-003")).toEqual(["4111-1111-1111-1111-003"]);
  });

  it("rejects Luhn-passing runs of unrelated numbers", () => {
    // 5550123420240601 passes Luhn, but this is a phone number and a date.
    expect(luhnValid("5550123420240601")).toBe(true);
    expect(values(d, "ref 55501234 2024-06-01")).toEqual([]);
    expect(values(d, "4111 1111-1111 1111")).toEqual([]);
    expect(values(d, "41111 11111 11111 1")).toEqual([]);
  });
});

describe("dobDetector", () => {
  const d = dobDetector();

  it("finds dates after a birth cue in several formats", () => {
    expect(values(d, "DOB: 03/14/1979")).toEqual(["03/14/1979"]);
    expect(values(d, "D.O.B. 3-14-79")).toEqual(["3-14-79"]);
    expect(values(d, "born 1948-11-02")).toEqual(["1948-11-02"]);
    expect(values(d, "Date of birth: July 4, 1985")).toEqual(["July 4, 1985"]);
    expect(values(d, "birthdate is 4 Jul 1985")).toEqual(["4 Jul 1985"]);
  });

  it("accepts day-first numeric dates after a birth cue", () => {
    expect(values(d, "DOB: 15/02/1988")).toEqual(["15/02/1988"]);
    expect(values(d, "DOB: 15/02/88")).toEqual(["15/02/88"]);
    expect(values(d, "D.O.B. 15.02.1988")).toEqual(["15.02.1988"]);
    expect(values(d, "born 15-02-1988")).toEqual(["15-02-1988"]);
    expect(values(d, "Date of birth 31/12/1990.")).toEqual(["31/12/1990"]);
    expect(values(d, "DOB: 15 Feb 1988")).toEqual(["15 Feb 1988"]);
    expect(values(d, "DOB: Feb 15, 1988")).toEqual(["Feb 15, 1988"]);
    expect(values(d, "DOB 1988-02-15")).toEqual(["1988-02-15"]);
  });

  it("rejects impossible day/month combinations and mixed separators", () => {
    expect(values(d, "DOB 45/45/88")).toEqual([]);
    expect(values(d, "DOB 31/13/88")).toEqual([]);
    expect(values(d, "DOB 00/02/1988")).toEqual([]);
    expect(values(d, "DOB 15/02-1988")).toEqual([]);
  });

  it("does not mask an uncued day-first date", () => {
    expect(values(d, "Date of loss 15/02/88")).toEqual([]);
    expect(values(d, "Loss on 09/06/2024 in London")).toEqual([]);
  });

  it("ignores dates without a DOB cue", () => {
    expect(values(d, "Date of loss 03/14/2024. Effective 01/01/2024.")).toEqual([]);
  });

  it("does not reach across a sentence or past another number", () => {
    expect(values(d, "DOB unknown. Loss on 03/14/2024")).toEqual([]);
    expect(values(d, "DOB pending, claim 55 filed 03/14/2024")).toEqual([]);
    expect(values(d, "Insured was born in Ohio and moved away in the spring of 2001, loss 03/14/2024")).toEqual([]);
  });
});

describe("driversLicenseDetector", () => {
  const d = driversLicenseDetector();

  it("finds license numbers after a cue", () => {
    expect(values(d, "DL# TX12345678")).toEqual(["TX12345678"]);
    expect(values(d, "license #: D1234-5678-9012")).toEqual(["D1234-5678-9012"]);
    expect(values(d, "Driver's License No. A1234567")).toEqual(["A1234567"]);
  });

  it("requires a digit and a cue", () => {
    expect(values(d, "license: suspended")).toEqual([]);
    expect(values(d, "TX12345678")).toEqual([]);
  });
});

describe("addressDetector", () => {
  const d = addressDetector();

  it("finds street addresses with unit and city/state/zip", () => {
    expect(values(d, "at 4821 Oak Hollow Dr, Apt 3B, Austin, TX 78745.")).toEqual([
      "4821 Oak Hollow Dr, Apt 3B, Austin, TX 78745",
    ]);
    expect(values(d, "77 W 3rd St")).toEqual(["77 W 3rd St"]);
    expect(values(d, "1290 Elm Street")).toEqual(["1290 Elm Street"]);
  });

  it("ignores counts followed by ordinary words", () => {
    expect(values(d, "3 bedrooms affected, 12 Years old roof")).toEqual([]);
  });
});

describe("personDetector", () => {
  const d = personDetector();

  it("finds names after titles and labels", () => {
    expect(values(d, "Spoke with Mr. James O'Neil today")).toEqual(["James O'Neil"]);
    expect(values(d, "Insured: Maria Gonzalez, DOB")).toEqual(["Maria Gonzalez"]);
    expect(values(d, "policyholder: Daniel K. Whitfield")).toEqual(["Daniel K. Whitfield"]);
    expect(values(d, "Witness: Dr. Alan Pierce")).toEqual(["Alan Pierce"]);
    expect(values(d, "Beneficiary: Susan McAllister-Reyes")).toEqual(["Susan McAllister-Reyes"]);
  });

  it("treats accented and non-ASCII letters as part of a name", () => {
    expect(values(d, "Insured: Ana María Rojas-Vargas, DOB 03/14/1988")).toEqual(["Ana María Rojas-Vargas"]);
    expect(values(d, "Claimant: José Ángel Núñez")).toEqual(["José Ángel Núñez"]);
    expect(values(d, "Contact: Mrs. Zoë Müller-Łukasik")).toEqual(["Zoë Müller-Łukasik"]);
  });

  it("stops before label words and next fields", () => {
    expect(values(d, "Insured: Maria Gonzalez Policy 123")).toEqual(["Maria Gonzalez"]);
    expect(values(d, "Name: Ana Ruiz Phone: 555")).toEqual(["Ana Ruiz"]);
  });

  it("does not detect uncued names (documented gap)", () => {
    expect(values(d, "Spoke with Maria Gonzalez today")).toEqual([]);
  });
});

describe("overlap resolution", () => {
  const f = (start: number, end: number, confidence: number, category = "X"): Finding => ({
    category,
    start,
    end,
    value: "",
    confidence,
  });

  it("keeps the longest match", () => {
    expect(resolveOverlaps([f(0, 5, 0.99, "A"), f(0, 10, 0.5, "B")]).map((x) => x.category)).toEqual(["B"]);
  });

  it("breaks length ties by confidence", () => {
    expect(resolveOverlaps([f(0, 10, 0.6, "A"), f(2, 12, 0.9, "B")]).map((x) => x.category)).toEqual(["B"]);
  });

  it("keeps non-overlapping matches in position order", () => {
    expect(resolveOverlaps([f(10, 12, 1), f(0, 5, 1)]).map((x) => x.start)).toEqual([0, 10]);
  });

  it("prefers the card over a phone-like substring", () => {
    expect(detect("card 4111 1111 1111 1111").map((x) => x.category)).toEqual(["CREDIT_CARD"]);
  });
});

describe("pluggable detectors", () => {
  it("accepts external findings via staticDetector and drops stale spans", () => {
    const text = "Adjuster spoke with Maria about the claim";
    const ner = staticDetector("ner", [
      { category: "PERSON", start: 20, end: 25, value: "Maria", confidence: 0.9 },
      { category: "PERSON", start: 0, end: 3, value: "Bob", confidence: 0.9 },
    ]);
    expect(detect(text, { detectors: [ner] }).map((x) => x.value)).toEqual(["Maria"]);
  });
});
