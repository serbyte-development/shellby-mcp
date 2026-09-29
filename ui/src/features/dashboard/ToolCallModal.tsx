// biome-ignore-all lint/security/noDangerouslySetInnerHtml: The highlighting module escapes all source text before adding syntax markup.
import * as Dialog from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { Button } from "../../components/ui/button"
import type { AgentCall } from "../../types"
import { highlightInput, highlightResponse } from "./highlight-tool-text"

export function ToolCallModal({ call, onClose }: { call?: AgentCall; onClose: () => void }) {
  const detail = call?.detail ?? (call?.summary || "No captured input for this tool call.")
  const highlighted = highlightInput(detail, call?.detailLanguage)

  return (
    <Dialog.Root open={Boolean(call)} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[min(760px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border bg-background shadow-2xl outline-none">
          <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-base font-semibold">{call?.tool}</Dialog.Title>
              {call?.summary ? (
                <Dialog.Description className="mt-1 truncate text-xs text-muted-foreground">
                  {call.summary}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                aria-label="Close tool call details"
              >
                <X className="size-4" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 space-y-4 overflow-auto p-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Input
              <TokenCount count={call?.inputTokens} />
            </h3>
            <pre className="overflow-x-auto rounded-lg border bg-muted/30 p-4 text-xs leading-5">
              <code
                className="hljs bg-transparent p-0"
                dangerouslySetInnerHTML={{ __html: highlighted }}
              />
            </pre>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Output returned to agent
              <TokenCount count={call?.outputTokens} />
            </h3>
            {call?.response !== undefined ? (
              <pre className="whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-4 text-xs leading-5">
                <code
                  dangerouslySetInnerHTML={{
                    __html: highlightResponse(call.response || "No content returned."),
                  }}
                />
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground">
                {call?.status === "running"
                  ? "Waiting for the tool to return…"
                  : "Output was not captured for this call."}
              </p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function TokenCount({ count }: { count?: number }) {
  if (count === undefined) return null
  return (
    <span
      className="ml-2 font-normal normal-case tracking-normal"
      title="Full tool arguments and returned text/structured content (o200k_base), before display truncation. Excludes binary media and protocol overhead."
    >
      {" "}
      {count.toLocaleString()} tokens
    </span>
  )
}
