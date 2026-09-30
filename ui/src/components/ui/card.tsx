import type { HTMLAttributes, ReactNode } from "react"

import { cn } from "../../lib/utils"

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-xl border bg-card text-card-foreground shadow-card", className)}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 p-4", className)} {...props} />
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4 pt-0", className)} {...props} />
}

export function CardPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border bg-surface p-3 shadow-panel">
      <h3 className="mb-2 text-xs font-semibold text-foreground/90">{title}</h3>
      {children}
    </div>
  )
}
