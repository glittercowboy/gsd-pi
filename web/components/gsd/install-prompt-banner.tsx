"use client"

import { useState } from "react"
import { useInstallPrompt } from "@/hooks/use-install-prompt"
import { Button } from "@/components/ui/button"
import { X, Download } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"

export function InstallPromptBanner() {
  const { canInstall, promptInstall } = useInstallPrompt()
  const [dismissed, setDismissed] = useState(false)

  if (!canInstall || dismissed) return null

  return (
    <AnimatePresence>
      <motion.div
        key="install-banner"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 16 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2"
        data-testid="install-prompt-banner"
      >
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 shadow-lg shadow-black/20">
          <Download className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm text-foreground whitespace-nowrap">
            Install GSD as a desktop app
          </span>
          <Button
            size="sm"
            onClick={() => void promptInstall()}
            data-testid="install-prompt-action"
          >
            Install
          </Button>
          <button
            onClick={() => setDismissed(true)}
            className="ml-0.5 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Dismiss install prompt"
            data-testid="install-prompt-dismiss"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
