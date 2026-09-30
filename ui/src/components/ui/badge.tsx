import type { HTMLAttributes } from "react"

import { cn } from "../../lib/utils"

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-transparent bg-muted px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}
