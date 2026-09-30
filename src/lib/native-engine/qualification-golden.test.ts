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
    // 归一 CRLF 后再哈希:Windows 检出(core.autocrlf)会把该文件行尾转为
    // CRLF,冻结哈希按 LF 内容计算——门源码本身不变,只是行尾差异。
    const source = readFileSync("native-engine/engine/qualification.py").toString("utf8").replace(/\r\n/g, "\n")
    expect(createHash("sha256").update(source).digest("hex")).toBe(fixture.qualification_sha256)
    expect(fixture.cases).toHaveLength(224)
  })
  it.each(fixture.cases)("$name", test => {
    const actual = qualifyResearchCandidates(test.candidates as unknown as Champion[], test.required as QualificationRequirements, test.final)
    expect(actual).toEqual(test.expected)
  })
})
