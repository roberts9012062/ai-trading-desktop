import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import type { Champion } from "@/lib/factor-lab-api"
import { qualifyResearchCandidates, type QualificationRequirements } from "./qualification"
const fixture = JSON.parse(gunzipSync(readFileSync("tests/native_engine/fixtures/champion-qualification.json.gz")).toString("utf8")) as {
  qualification_sha256: string; cases: Array<{ name: string; candidates: Champion[]; required: QualificationRequirements; final: boolean; expected: unknown }>
}

describe("G2 CPU/native host qualification parity", () => {
  it("locks the authoritative Python gate source", () => {
    expect(createHash("sha256").update(readFileSync("native-engine/engine/qualification.py")).digest("hex")).toBe(fixture.qualification_sha256)
    expect(fixture.cases).toHaveLength(224)
  })
  it.each(fixture.cases)("$name", test => {
    const actual = qualifyResearchCandidates(test.candidates as unknown as Champion[], test.required as QualificationRequirements, test.final)
    expect(actual).toEqual(test.expected)
  })
})
