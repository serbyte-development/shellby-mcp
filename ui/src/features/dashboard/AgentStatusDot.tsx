export function AgentStatusDot({ active }: { active: boolean }) {
  return (
    <span
      className={`size-2.5 shrink-0 rounded-full ${active ? "bg-success shadow-[0_0_0_3px_rgba(16,185,129,0.12)]" : "bg-muted-foreground/50"}`}
    />
  )
}
