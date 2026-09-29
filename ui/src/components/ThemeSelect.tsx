import { useState } from "react"

const storageKey = "shellby-theme"

/** Restore the preference before rendering; CSS follows the OS in system mode. */
export function initializeTheme() {
  let theme = "system"
  try {
    const saved = localStorage.getItem(storageKey)
    if (saved === "light" || saved === "dark") theme = saved
  } catch {
    // Theme selection still works when browser storage is unavailable.
  }
  document.documentElement.dataset.theme = theme
}

export function ThemeSelect() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "system")

  return (
    <select
      aria-label="Color theme"
      className="h-8 rounded-md border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-muted-foreground"
      value={theme}
      onChange={(event) => {
        const nextTheme = event.target.value
        document.documentElement.dataset.theme = nextTheme
        setTheme(nextTheme)
        try {
          localStorage.setItem(storageKey, nextTheme)
        } catch {
          // Keep the selected theme for this page even if it cannot be saved.
        }
      }}
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  )
}
