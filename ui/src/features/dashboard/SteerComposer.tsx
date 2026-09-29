import { Check, CircleAlert, Clock3, LoaderCircle, Send } from "lucide-react"
import { useState } from "react"

import { Button } from "../../components/ui/button"
import { Textarea } from "../../components/ui/textarea"
import { cancelSteer, steerAgent } from "../../lib/api"
import type { Agent, AgentInstruction } from "../../types"

export function SteerComposer({
  agent,
  onDismissInstruction,
}: {
  agent: Agent
  onDismissInstruction: (instructionId: string) => void
}) {
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string>()
  const pending = agent.instructions.filter((instruction) => instruction.deliveredAt === undefined)
  const latestDelivered = agent.instructions.find(
    (instruction) => instruction.deliveredAt !== undefined
  )

  async function submit() {
    const trimmed = message.trim()
    if (!trimmed || sending) return
    setSending(true)
    setError(undefined)
    try {
      await steerAgent(agent.id, trimmed)
      setMessage("")
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : String(sendError))
    } finally {
      setSending(false)
    }
  }

  async function cancelQueued(instruction: AgentInstruction) {
    if (cancelling) return
    setCancelling(true)
    setError(undefined)
    try {
      await cancelSteer(agent.id, instruction.id)
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError))
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="space-y-1.5 border-t pt-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Steer
      </h3>
      <div className="relative">
        <Textarea
          rows={1}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit()
          }}
          className="max-h-32 min-h-9 pr-10 field-sizing-content"
          placeholder="Steer this agent..."
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={`absolute right-1 top-1 size-7 ${message.trim() && !sending ? "bg-blue-600 hover:bg-accent-muted hover:text-accent text-white" : "text-muted-foreground"}`}
          aria-label="Send instruction"
          disabled={!message.trim() || sending}
          onClick={() => void submit()}
        >
          {sending ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
        </Button>
      </div>
      <SteerStatus
        sending={sending}
        cancelling={cancelling}
        error={error}
        queued={pending}
        delivered={latestDelivered}
        onCancelQueued={cancelQueued}
        onDismissDelivered={() => latestDelivered && onDismissInstruction(latestDelivered.id)}
      />
    </div>
  )
}

function SteerStatus({
  sending,
  cancelling,
  error,
  queued,
  delivered,
  onCancelQueued,
  onDismissDelivered,
}: {
  sending: boolean
  cancelling: boolean
  error?: string
  queued: AgentInstruction[]
  delivered?: AgentInstruction
  onCancelQueued: (instruction: AgentInstruction) => void
  onDismissDelivered: () => void
}) {
  if (sending) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" />
        Sending…
      </p>
    )
  }
  if (error) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CircleAlert className="size-3.5 text-destructive" />
        {error}
      </p>
    )
  }
  if (queued.length > 0) {
    return (
      <p className="group relative flex min-w-0 items-center gap-1.5 pr-16 text-xs text-muted-foreground">
        <Clock3 className="size-3.5 shrink-0 text-warning" />
        <span className="truncate">
          {queued.length === 1
            ? `Queued: ${queued[0].message}`
            : `${queued.length} queued · ${queued[0].message}`}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="pointer-events-none absolute right-0 top-1/2 h-6 -translate-y-1/2 px-2 text-[11px] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          aria-label="Cancel queued instruction"
          disabled={cancelling}
          onClick={() => onCancelQueued(queued[0])}
        >
          {cancelling ? <LoaderCircle className="size-3.5 animate-spin" /> : "Cancel"}
        </Button>
      </p>
    )
  }
  if (delivered) {
    return (
      <p className="group relative flex min-w-0 items-center gap-1.5 pr-16 text-xs text-muted-foreground">
        <Check className="size-3.5 shrink-0 text-success" />
        <span className="truncate">Delivered: {delivered.message}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="pointer-events-none absolute right-0 top-1/2 h-6 -translate-y-1/2 px-2 text-[11px] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          aria-label="Dismiss delivered instruction"
          onClick={onDismissDelivered}
        >
          Dismiss
        </Button>
      </p>
    )
  }
  return null
}
