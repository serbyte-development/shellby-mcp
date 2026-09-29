const logTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
})

/** Format epoch milliseconds as Pacific time; defaults to the current time for reviews. */
export function getTimeStamp(at: number = Date.now()): string {
  const parts = Object.fromEntries(
    logTimeFormatter.formatToParts(new Date(at)).map(({ type, value }) => [type, value])
  )
  return `${parts.month} ${parts.day} ${parts.hour}:${parts.minute} ${parts.dayPeriod}`
}
