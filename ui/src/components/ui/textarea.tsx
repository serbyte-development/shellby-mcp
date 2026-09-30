import type { TextareaHTMLAttributes } from "react"

import { cn } from "../../lib/utils"

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "flex min-h-9 w-full resize-none rounded-md border border-input/70 bg-background/70 px-3 py-2.5 text-xs leading-5 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}
