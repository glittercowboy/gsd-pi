"use client"

import Image from "next/image"
import { motion } from "motion/react"
import { ArrowRight } from "lucide-react"

import { Button } from "@/components/ui/button"

interface StepWelcomeProps {
  onNext: () => void
}

export function StepWelcome({ onNext }: StepWelcomeProps) {
  return (
    <div className="flex flex-col items-center text-center">
      {/* Logo mark with glow */}
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", duration: 0.6, bounce: 0 }}
        className="relative"
      >
        <div className="absolute inset-0 rounded-2xl bg-foreground/5 blur-2xl" />
        <div className="relative mb-4 flex h-18 items-center justify-center">
          <Image
            src="/logo-white.svg"
            alt="GSD"
            height={70}
            width={200}
            className="hidden dark:block"
          />
          <Image
            src="/logo-black.svg"
            alt="GSD"
            height={70}
            width={200}
            className="dark:hidden"
          />
        </div>
      </motion.div>

      {/* Headline */}
      <motion.p
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.16, duration: 0.4 }}
        className="max-w-sm text-[15px] leading-relaxed text-muted-foreground"
      >
        Let's get your workspace ready. This takes about a minute.
      </motion.p>

      {/* Steps preview */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.24, duration: 0.4 }}
        className="mt-10 flex items-center gap-3 text-xs text-muted-foreground"
      >
        {["Mode", "Provider", "Auth", "Workspace"].map((label, i) => (
          <span key={label} className="flex items-center gap-3">
            {i > 0 && (
              <span className="h-px w-5 bg-border" />
            )}
            <span className="font-medium">{label}</span>
          </span>
        ))}
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35, duration: 0.4 }}
        className="mt-10"
      >
        <Button
          size="lg"
          className="group gap-2.5 px-8 text-[15px] transition-transform active:scale-[0.96]"
          onClick={onNext}
          data-testid="onboarding-start"
        >
          Get started
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </motion.div>
    </div>
  )
}
