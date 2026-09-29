/**
 * Refresh selector-relevant ChatGPT markup from the managed, authenticated browser.
 * Reads home, the configured project, and the live suite's saved conversation.
 * Never submits a message or creates a conversation. Only an owned tab is navigated/closed.
 * Captures attributes, not drafts, answers, account data, application scripts, or network bodies.
 */
import { readFile, rename, writeFile } from "node:fs/promises"
import { chromium, type Page } from "playwright-core"
import { MCP_CONFIG } from "../../src/config.js"
import { createBackgroundPage } from "../../src/tools/delegation/chatgpt-browser.js"

const saved: { conversation_url?: unknown } = JSON.parse(
  await readFile(
    new URL("../../test/live/artifacts/subagent-live-conversation.json", import.meta.url),
    "utf8"
  )
)
if (
  typeof saved.conversation_url !== "string" ||
  !/^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\/[^/?#]+$/u.test(saved.conversation_url)
)
  throw new Error(
    "The live suite must have a saved ChatGPT conversation before capturing fixtures."
  )

const sources = {
  home: "https://chatgpt.com/",
  project: MCP_CONFIG.chatGpt.projectUrl,
  conversation: saved.conversation_url,
}
const browser = await chromium.connectOverCDP(MCP_CONFIG.chatGpt.cdpEndpoint, { timeout: 5_000 })
let ownedPage: Page | undefined
try {
  const context = browser.contexts()[0]
  if (!context) throw new Error("Managed Chrome has no browser context.")
  const composers: Record<string, string> = {}
  for (const [surface, url] of Object.entries(sources)) {
    let page = context.pages().find((candidate) => candidate.url() === url)
    if (!page) {
      ownedPage ??= await createBackgroundPage(browser, context)
      page = ownedPage
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    }
    // Deliberately independent of the production selectors: a changed attribute
    // must reach the fixture and fail its consumer tests, not be repaired here.
    await page
      .locator('form [contenteditable="true"][role="textbox"]:visible, form textarea:visible')
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
    composers[surface] = await page.evaluate(() => {
      const editors = [
        ...document.querySelectorAll(
          'form [contenteditable="true"][role="textbox"], form textarea'
        ),
      ].filter(
        (element) =>
          element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden"
      )
      const [editor] = editors
      if (editors.length !== 1 || !editor)
        throw new Error(`Expected one visible editor, found ${editors.length}.`)
      const form = editor.closest("form")
      const send = form?.querySelector('button[type="submit"]')
      if (!form || !send)
        throw new Error(
          "No submit button; inspect the changed composer before refreshing fixtures."
        )

      // Shallow copies retain the DOM contract without copying user content.
      const formCopy = document.createElement(form.localName)
      const editorCopy = document.createElement(editor.localName)
      const sendCopy = document.createElement(send.localName)
      for (const [element, copy] of [
        [form, formCopy],
        [editor, editorCopy],
        [send, sendCopy],
      ] as const) {
        for (const attribute of element.attributes) {
          if (
            !/^(?:id|role|contenteditable|type|disabled|hidden|dir|spellcheck|translate|placeholder|aria-(?:label|multiline|disabled)|data-(?:testid|composer-[\w-]+|chatgpt-composer|thread-find-composer))$/u.test(
              attribute.name
            )
          )
            continue
          const value = attribute.value.replace(/^New chat in .+$/u, "New chat in Test project")
          copy.setAttribute(attribute.name, value)
        }
      }
      if (editorCopy.getAttribute("contenteditable") === "true")
        editorCopy.innerHTML = "<p><br></p>"
      // An icon makes the empty button visible without inventing an accessible label.
      sendCopy.innerHTML = '<span aria-hidden="true">↑</span>'
      formCopy.append(editorCopy, sendCopy)
      return formCopy.outerHTML
    })
    console.log(`Captured ${surface} composer.`)
  }
  const output = new URL("../../test/fixtures/chatgpt-dom.json", import.meta.url)
  const pending = new URL(`${output.href}.tmp`)
  await writeFile(
    pending,
    `${JSON.stringify(
      {
        captured_at: new Date().toISOString(),
        chrome_version: browser.version(),
        scope:
          "Sanitized form, editor, and Send attributes from live ChatGPT. Layout, app behavior, fork menus, and network responses are simulated by the tests.",
        composers,
      },
      null,
      2
    )}\n`
  )
  await rename(pending, output)
  console.log(`Updated ${output.pathname}; no messages submitted.`)
} finally {
  try {
    await ownedPage?.close()
  } finally {
    await browser.close()
  }
}
