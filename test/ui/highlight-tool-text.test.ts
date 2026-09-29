import assert from "node:assert/strict"
import test from "node:test"
import { parseHTML } from "linkedom"
import { highlightResponse } from "../../ui/src/features/dashboard/highlight-tool-text.js"

test("colors labeled fences without rendering surrounding Markdown or changing text", () => {
  const text =
    '# Plain heading\n**Not bold**\n\n```js\nconst value = "<script>";\n```\n\n```markdown\n# Colored heading\n**Still literal**\n```\nAfter\n'
  const { document } = parseHTML(`<pre>${highlightResponse(text)}</pre>`)
  const pre = document.querySelector("pre")!
  assert.equal(pre.textContent, text)
  assert.equal(pre.querySelector(".hljs-keyword")?.textContent, "const")
  assert.equal(pre.querySelector(".hljs-section")?.textContent, "# Colored heading")
  assert.equal(pre.querySelector("h1, strong, script"), null)
})

test("unlabeled and unknown fences stay plain, including HTML-like content", () => {
  const text =
    "Before <img src=x onerror=alert(1)>\n```\nconst x = 1;\n```\n~~~unknown\n<script>bad()</script>\n~~~\nAfter & done"
  const { document } = parseHTML(`<pre>${highlightResponse(text)}</pre>`)
  const pre = document.querySelector("pre")!
  assert.equal(pre.textContent, text)
  assert.equal(pre.children.length, 0)
})

test("longer fences enclose shorter fences and unfinished labeled blocks can be highlighted", () => {
  const text = '````markdown\n```js\nconst x = 1;\n```\n````\n  ~~~python\nprint("hello")'
  const { document } = parseHTML(`<pre>${highlightResponse(text)}</pre>`)
  const pre = document.querySelector("pre")!
  assert.equal(pre.textContent, text)
  assert.equal(pre.querySelector(".hljs-built_in")?.textContent, "print")
})
