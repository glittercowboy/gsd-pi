"use client"

import Image from "next/image"
import { motion } from "motion/react"
import { CheckCircle2, Zap } from "lucide-react"

import { Button } from "@/components/ui/button"

interface StepReadyProps {
  providerLabel: string
  onFinish: () => void
}

export function StepReady({ providerLabel, onFinish }: StepReadyProps) {
  return (
    <div className="flex flex-col items-center text-center">
      {/* Success icon with staggered entrance */}
      <motion.div
        initial={{ opacity: 0, scale: 0.7 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", duration: 0.6, bounce: 0.15 }}
        className="relative mb-8"
      >
        <div className="absolute inset-0 rounded-full bg-success/10 blur-2xl" />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-success/20 bg-success/10">
          <CheckCircle2 className="h-8 w-8 text-success" strokeWidth={1.5} />
        </div>
      </motion.div>

      <motion.h2
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.4 }}
        className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl"
      >
        You&apos;re all set
      </motion.h2>

      <motion.p
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18, duration: 0.4 }}
        className="mt-3 max-w-sm text-[15px] leading-relaxed text-muted-foreground"
      >
        <span className="font-medium text-foreground">{providerLabel}</span> is
        validated. The workspace is live.
      </motion.p>

      {/* Compact summary strip */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.26, duration: 0.4 }}
        className="mt-8 flex items-center gap-4 rounded-xl border border-border/50 bg-card/50 px-5 py-3"
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Image
            src="/logo-icon-white.svg"
            alt=""
            width={14}
            height={14}
            className="hidden opacity-40 dark:block"
          />
          <Image
            src="/logo-icon-black.svg"
            alt=""
            width={14}
            height={14}
            className="opacity-40 dark:hidden"
          />
          <span>Shell unlocked</span>
        </div>
        <div className="h-3 w-px bg-border" />
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          <span>{providerLabel}</span>
        </div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.4 }}
        className="mt-8"
      >
        <Button
          size="lg"
          className="group gap-2.5 px-8 text-[15px] transition-transform active:scale-[0.96]"
          onClick={onFinish}
          data-testid="onboarding-finish"
        >
          Launch workspace
          <Zap className="h-4 w-4 transition-transform group-hover:scale-110" />
        </Button>
      </motion.div>
    </div>
  )
}
