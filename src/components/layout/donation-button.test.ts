import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { DonationButton } from "./donation-button"

it("keeps the donation entry available before its first configuration request completes", () => {
  const html = renderToStaticMarkup(createElement(DonationButton))
  expect(html).toContain('aria-label="打赏"')
})
