const logTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
})

/** Shared Pacific timestamp for audit entries and reviews. */
export function getTimeStamp(): string {
  const parts = Object.fromEntries(
    logTimeFormatter.formatToParts(new Date()).map(({ type, value }) => [type, value])
  )
  return `${parts.month} ${parts.day} ${parts.hour}:${parts.minute} ${parts.dayPeriod}`
}
