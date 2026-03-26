"use client"

import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

// ─── Dashboard skeletons ──────────────────────────────────────────────────────

function MetricCardSkeleton({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
          <Skeleton className="mt-2 h-7 w-24" />
          <Skeleton className="mt-1.5 h-3 w-20" />
        </div>
        <div className="shrink-0 rounded-md bg-accent p-2 text-muted-foreground">{icon}</div>
      </div>
    </div>
  )
}

function CurrentUnitCardSkeleton({ icon }: { icon: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Current Unit</p>
          <Skeleton className="mt-2 h-7 w-20" />
          <Skeleton className="mt-1.5 h-3 w-16" />
        </div>
        <div className="shrink-0 rounded-md bg-accent p-2 text-muted-foreground">{icon}</div>
      </div>
    </div>
  )
}

export function CurrentSliceCardSkeleton() {
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Current Slice</h2>
      </div>
      <div className="space-y-3 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
            <Skeleton className={cn("h-4", i === 1 ? "w-48" : i === 2 ? "w-40" : "w-36")} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function SessionCardSkeleton() {
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Session</h2>
      </div>
      <div className="p-4">
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <Skeleton className="h-3.5 w-3.5 rounded" />
                <span className="text-muted-foreground">{i === 1 ? "Model" : i === 2 ? "Cost" : "Tokens"}</span>
              </div>
              <Skeleton className={cn("h-4", i === 1 ? "w-28" : "w-12")} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function RecoveryCardSkeleton() {
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Recovery Summary</h2>
      </div>
      <div className="space-y-4 p-4">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </div>
        <div className="space-y-1.5">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className={cn("h-3", i % 2 === 0 ? "w-28" : "w-36")} />
          ))}
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>
    </div>
  )
}

export function ActivityCardSkeleton() {
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Recent Activity</h2>
      </div>
      <div className="divide-y divide-border">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2.5">
            <Skeleton className="h-3 w-16 shrink-0" />
            <Skeleton className="h-1.5 w-1.5 shrink-0 rounded-full" />
            <Skeleton className={cn("h-4 flex-1", i % 3 === 0 ? "max-w-xs" : i % 3 === 1 ? "max-w-sm" : "max-w-md")} />
          </div>
        ))}
      </div>
    </div>
  )
}

interface DashboardSkeletonProps {
  icons: {
    Activity: React.ReactNode
    Clock: React.ReactNode
    DollarSign: React.ReactNode
    Zap: React.ReactNode
  }
}

export function DashboardMetricsSkeleton({ icons }: DashboardSkeletonProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-5">
      <CurrentUnitCardSkeleton icon={icons.Activity} />
      <MetricCardSkeleton label="Elapsed Time" icon={icons.Clock} />
      <MetricCardSkeleton label="Total Cost" icon={icons.DollarSign} />
      <MetricCardSkeleton label="Tokens Used" icon={icons.Zap} />
      <MetricCardSkeleton label="Progress" icon={icons.Activity} />
    </div>
  )
}

// ─── Sidebar skeletons ────────────────────────────────────────────────────────

/** Only the data-dependent portion of the sidebar content panel */
export function SidebarDataSkeleton() {
  return (
    <>
      {/* Project path */}
      <Skeleton className="mt-2 h-3 w-36" />

      {/* Scope section */}
      <div className="border-b border-border px-3 py-3">
        <div className="space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Active scope</p>
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-2.5 w-28" />
        </div>
      </div>

      {/* Milestones list */}
      <div className="flex-1 overflow-y-auto py-1">
        <div className="px-2 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Milestones
          </span>
        </div>
        <div className="space-y-0.5 px-1">
          {[1, 2].map((m) => (
            <div key={m}>
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <Skeleton className="h-4 w-4 shrink-0 rounded" />
                <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
                <Skeleton className={cn("h-4", m === 1 ? "w-40" : "w-32")} />
              </div>
              {m === 1 && (
                <div className="ml-4 space-y-0.5">
                  {[1, 2, 3].map((s) => (
                    <div key={s} className="flex items-center gap-1.5 px-2 py-1.5">
                      <Skeleton className="h-4 w-4 shrink-0 rounded" />
                      <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
                      <Skeleton className={cn("h-3.5", s === 1 ? "w-32" : s === 2 ? "w-28" : "w-24")} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

// ─── Status bar value skeletons ───────────────────────────────────────────────

export function StatusBarValueSkeleton({ width = "w-16" }: { width?: string }) {
  return <Skeleton className={cn("h-3 inline-block", width)} />
}
