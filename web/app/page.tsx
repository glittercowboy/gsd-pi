"use client"

import dynamic from "next/dynamic"
import { LoginGate } from "@/components/gsd/login-gate"

const GSDAppShell = dynamic(
  () => import("@/components/gsd/app-shell").then((mod) => mod.GSDAppShell),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading workspace…
      </div>
    ),
  },
)

export default function Page() {
  return (
    <LoginGate>
      <GSDAppShell />
    </LoginGate>
  )
}
