import {afterEach, expect, it, vi} from "vitest"
import {createElement} from "react"
import {renderToStaticMarkup} from "react-dom/server"
import {MemoryRouter} from "react-router-dom"
import {FactorEvolutionPage} from "./evolution-page"
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react")
  return {...actual, useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot()}
})

afterEach(() => vi.unstubAllGlobals())
it("explains an inherited fixed test window before downloading or calling the model", () => {
  vi.stubGlobal("localStorage", {getItem: (key: string) => key.startsWith("factor-lab-validation:")
    ? JSON.stringify({enabled:true, train_ratio:.7, test_recent_bars:60, walk_forward_folds:3}) : null})
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(FactorEvolutionPage)))
  expect(html).toContain("固定测试窗口过短")
  expect(html).toContain("改为按比例切分")
})
