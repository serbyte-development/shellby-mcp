import type { ReactNode } from "react"

export function WorkspaceHeader({
  title,
  description,
  leading,
  children,
}: {
  title: string
  description: ReactNode
  leading: ReactNode
  children: ReactNode
}) {
  return (
    <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-375 flex-wrap items-center justify-between gap-4 px-4 py-4 lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          {leading}
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>
    </header>
  )
}
