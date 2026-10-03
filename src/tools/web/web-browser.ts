import { type Browser, chromium, type Page } from "playwright-core"
import { MCP_CONFIG } from "../../config.js"
import { createBackgroundPage } from "../delegation/chatgpt-browser.js"
import { WebOpenError } from "./web-error.js"

/**
 * Give one fetch its own page and release it on success, failure, or cancellation.
 * Headful reads attach to the configured Chrome profile without changing its settings.
 * Concurrent reads own separate tabs/connections; the existing browser is never shut down.
 */
export async function withWebPage<T>(
  options: { headless: boolean; signal?: AbortSignal },
  read: (page: Page) => Promise<T>
): Promise<T> {
  const { headless, signal } = options
  signal?.throwIfAborted()
  let browser: Browser | undefined
  let page: Page | undefined
  const abort = () => {
    void page?.close().catch(() => undefined)
  }

  try {
    if (headless) {
      // Web reads are infrequent, so the default path owns a browser only for this fetch.
      const { launch } = await import("cloakbrowser")
      browser = await launch({ headless: true })
      signal?.throwIfAborted()
      page = await browser.newPage()
      await page.route("**/*", async (route) => {
        const resourceType = route.request().resourceType()
        if (resourceType === "image" || resourceType === "media" || resourceType === "font") {
          await route.abort()
          return
        }
        await route.continue()
      })
    } else {
      browser = await chromium.connectOverCDP(MCP_CONFIG.chatGpt.cdpEndpoint, {
        timeout: 10_000,
        noDefaults: true,
      })
      signal?.throwIfAborted()
      const context = browser.contexts()[0]
      if (!context) {
        throw new WebOpenError("open_failed", "Connected Chrome did not expose its profile.")
      }
      // Use the existing profile's cookies and normal resource loading without stealing focus.
      page = await createBackgroundPage(browser, context)
    }

    signal?.addEventListener("abort", abort, { once: true })
    signal?.throwIfAborted()
    return await read(page)
  } finally {
    signal?.removeEventListener("abort", abort)
    await page?.close().catch(() => undefined)
    // For connectOverCDP this disconnects our client; the shared Chrome stays running.
    await browser?.close()
  }
}
