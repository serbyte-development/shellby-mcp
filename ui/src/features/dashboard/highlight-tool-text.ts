import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import diff from "highlight.js/lib/languages/diff"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

for (const [name, grammar] of Object.entries({
  bash,
  css,
  diff,
  javascript,
  json,
  markdown,
  python,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, grammar)
}

export function highlightInput(text: string, language?: string): string {
  return language && hljs.getLanguage(language)
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text, ["bash", "diff", "json"]).value
}

/** Escaped HTML that colors only labeled fences, preserving all original text and whitespace. */
export function highlightResponse(text: string): string {
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm
  let html = ""
  let cursor = 0
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    // biome-ignore lint/style/noNonNullAssertion: The opening regex always captures a nonempty fence.
    const fence = match[1]!
    const language = match[2]?.trim().split(/\s/u)[0]?.toLowerCase()
    const start = opening.lastIndex
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`, "gm")
    closing.lastIndex = start
    const end = closing.exec(text)
    const contentEnd = end?.index ?? text.length
    const code = text.slice(start, contentEnd)
    html += escapeHtml(text.slice(cursor, start))
    html +=
      language && hljs.getLanguage(language)
        ? hljs.highlight(code, { language }).value
        : escapeHtml(code)
    cursor = end ? closing.lastIndex : text.length
    html += escapeHtml(text.slice(contentEnd, cursor))
    opening.lastIndex = cursor
  }
  return html + escapeHtml(text.slice(cursor))
}

function escapeHtml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
}
