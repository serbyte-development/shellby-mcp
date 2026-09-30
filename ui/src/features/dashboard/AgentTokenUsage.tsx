import type { Agent } from "../../types"

const compactTokens = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
})

export function AgentTokenUsage({ usage }: { usage: Agent["toolUsage"] }) {
  return (
    <fieldset
      aria-label="Tool token totals"
      className="grid min-w-0 grid-cols-[auto_6ch] gap-x-2 gap-y-0.5 rounded-md border bg-surface px-2 py-1 font-mono text-[10px] leading-3 tabular-nums shadow-panel"
    >
      {[
        { label: "I", direction: "input", count: usage?.inputTokens },
        { label: "O", direction: "output", count: usage?.outputTokens },
      ].map(({ label, direction, count }) => (
        <div
          key={label}
          className="col-span-2 grid grid-cols-subgrid"
          title={
            count === undefined
              ? `Tool ${direction} total unavailable`
              : `Total captured tool ${direction}: ${count.toLocaleString()} tokens since MCP started`
          }
        >
          <span className="text-muted-foreground">{label}</span>
          <output
            className="text-right text-foreground/80"
            aria-label={`Total tool ${direction}: ${count === undefined ? "unavailable" : `${count.toLocaleString()} tokens`}`}
          >
            {count === undefined ? "—" : compactTokens.format(count)}
          </output>
        </div>
      ))}
    </fieldset>
  )
}
