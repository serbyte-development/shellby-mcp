import {
  IconAlertCircle,
  IconCheck,
  IconClock,
  IconLoader2,
  IconSend,
} from "@react-zero-ui/icon-sprite"
import { useState } from "react"

import { Button } from "../../components/ui/button"
import { CardPanel } from "../../components/ui/card"
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
  const [cancellingId, setCancellingId] = useState<string>()
  const [error, setError] = useState<string>()

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
    if (cancellingId) return
    setCancellingId(instruction.id)
    setError(undefined)
    try {
      await cancelSteer(agent.id, instruction.id)
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError))
    } finally {
      setCancellingId(undefined)
    }
  }

  return (
    <CardPanel title="Steer agent">
      <div className="space-y-2">
        <div className="relative">
          <Textarea
            rows={1}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit()
            }}
            className="h-20 pr-12"
            placeholder="Steer this agent..."
          />
          <Button
            type="button"
            size="icon"
            className="absolute right-2 top-2 size-8 rounded-md"
            aria-label="Send instruction"
            disabled={!message.trim() || sending}
            onClick={() => void submit()}
          >
            {sending ? (
              <IconLoader2 className="size-3.5 animate-spin" />
            ) : (
              <IconSend className="size-3.5" />
            )}
          </Button>
        </div>
        <SteerInstructionList
          instructions={agent.instructions}
          sending={sending}
          cancellingId={cancellingId}
          error={error}
          onCancel={cancelQueued}
          onDismiss={onDismissInstruction}
        />
      </div>
    </CardPanel>
  )
}

function SteerInstructionList({
  instructions,
  sending,
  cancellingId,
  error,
  onCancel,
  onDismiss,
}: {
  instructions: AgentInstruction[]
  sending: boolean
  cancellingId?: string
  error?: string
  onCancel: (instruction: AgentInstruction) => void
  onDismiss: (instructionId: string) => void
}) {
  return (
    <ul
      aria-label="Steer messages"
      className="h-22 space-y-0.5 overflow-y-auto pr-1 scrollbar-gutter-stable"
    >
      {sending ? (
        <li className="flex h-7 items-center gap-1.5 px-2 text-xs text-muted-foreground">
          <IconLoader2 className="size-3.5 shrink-0 animate-spin" />
          <span role="status">Sending…</span>
        </li>
      ) : null}
      {error ? (
        <li className="flex items-start gap-1.5 px-2 py-1.5 text-xs text-destructive">
          <IconAlertCircle className="size-3.5 shrink-0" />
          <span role="alert">{error}</span>
        </li>
      ) : null}
      {instructions.map((instruction) => {
        const delivered = instruction.deliveredAt !== undefined
        const cancelling = cancellingId === instruction.id
        const StatusIcon = cancelling ? IconLoader2 : delivered ? IconCheck : IconClock
        return (
          <li
            key={instruction.id}
            className="group relative flex h-7 min-w-0 items-center gap-1.5 rounded-md pl-2 pr-16 text-xs text-muted-foreground hover:bg-muted/60 focus-within:bg-muted/60"
          >
            <StatusIcon
              className={`size-3.5 shrink-0 ${cancelling ? "animate-spin" : delivered ? "text-success" : "text-warning"}`}
            />
            <span className="truncate" title={instruction.message}>
              {delivered ? "Delivered" : "Queued"}: {instruction.message}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="pointer-events-none absolute right-0 top-1/2 h-6 -translate-y-1/2 px-2 text-[11px] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
              aria-label={delivered ? "Dismiss delivered instruction" : "Cancel queued instruction"}
              disabled={!delivered && cancellingId !== undefined}
              onClick={() => (delivered ? onDismiss(instruction.id) : onCancel(instruction))}
            >
              {delivered ? "Dismiss" : "Cancel"}
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
