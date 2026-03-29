"use client"

import { useEffect, useRef, useState } from "react"
import Image from "next/image"
import { Eye, EyeOff, Loader2 } from "lucide-react"
import { motion } from "motion/react"

// ─── Types ───────────────────────────────────────────────────────────

type AuthState = "checking" | "needs_login" | "authenticated"
type ErrorKind = "wrong_password" | "rate_limited" | null

// ─── Main Component ──────────────────────────────────────────────────

export function LoginGate({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>("checking")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<ErrorKind>(null)
  const [rateLimitResetAt, setRateLimitResetAt] = useState(0)
  const [countdown, setCountdown] = useState(0)
  const [shakeKey, setShakeKey] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)

  // ─── Mount: check auth state ───
  useEffect(() => {
    // HTTP localhost: skip auth gate entirely (bearer token handles it)
    if (window.location.protocol !== "https:") {
      setAuthState("authenticated")
      return
    }

    // HTTPS: check if password auth is configured and if we have a valid session
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((data: { configured: boolean; authenticated: boolean }) => {
        if (!data.configured || data.authenticated) {
          setAuthState("authenticated")
        } else {
          setAuthState("needs_login")
        }
      })
      .catch(() => {
        // Can't reach status endpoint — let through, proxy will handle auth
        setAuthState("authenticated")
      })
  }, [])

  // ─── Auto-focus password input when login form appears ───
  useEffect(() => {
    if (authState === "needs_login") {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [authState])

  // ─── Rate limit countdown ───
  useEffect(() => {
    if (error !== "rate_limited" || !rateLimitResetAt) return
    const update = () => {
      const remaining = Math.max(0, Math.ceil((rateLimitResetAt - Date.now()) / 1000))
      setCountdown(remaining)
      if (remaining <= 0) {
        setError(null)
      }
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [error, rateLimitResetAt])

  // ─── Submit handler ───
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (loading || password.length < 4 || error === "rate_limited") return

    setLoading(true)
    setError(null)

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })

      if (res.ok) {
        // D-01: Hard reload — ensures browser processes Set-Cookie header
        window.location.reload()
        return
      }

      setLoading(false)

      if (res.status === 429) {
        const data = await res.json()
        setRateLimitResetAt(data.resetAt)
        setError("rate_limited")
      } else {
        // Trigger shake animation by incrementing key
        setShakeKey((k) => k + 1)
        setError("wrong_password")
        setPassword("")
        // Re-focus input after clearing
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    } catch {
      setLoading(false)
      setShakeKey((k) => k + 1)
      setError("wrong_password")
    }
  }

  // ─── Render: checking ───
  if (authState === "checking") {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // ─── Render: authenticated (pass through) ───
  if (authState === "authenticated") {
    return <>{children}</>
  }

  // ─── Render: login form ───
  const isRateLimited = error === "rate_limited"
  const isDisabled = loading || password.length < 4 || isRateLimited

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <motion.div
        key={shakeKey}
        animate={
          shakeKey > 0
            ? { x: [0, -8, 8, -8, 8, 0] }
            : { x: 0 }
        }
        transition={{ duration: 0.4 }}
        className="w-full max-w-sm"
      >
        <div className="rounded-xl border border-border bg-card p-8 shadow-lg">
          {/* Logo */}
          <div className="mb-8 flex justify-center">
            <Image
              src="/logo-white.svg"
              alt="GSD"
              width={57}
              height={16}
              className="hidden h-5 w-auto dark:block"
            />
            <Image
              src="/logo-black.svg"
              alt="GSD"
              width={57}
              height={16}
              className="h-5 w-auto dark:hidden"
            />
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Password field */}
            <div className="relative">
              <input
                ref={inputRef}
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  if (error === "wrong_password") setError(null)
                }}
                placeholder="Password"
                disabled={loading || isRateLimited}
                autoComplete="current-password"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>

            {/* Error message */}
            {error === "wrong_password" && (
              <p className="text-sm text-red-500" role="alert">
                Wrong password
              </p>
            )}
            {isRateLimited && (
              <p className="text-sm text-red-500" role="alert">
                Too many attempts. Try again in {countdown} seconds.
              </p>
            )}

            {/* Submit button */}
            <button
              type="submit"
              disabled={isDisabled}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ring-offset-background transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Logging in...
                </>
              ) : (
                "Log in"
              )}
            </button>
          </form>
        </div>
      </motion.div>
    </div>
  )
}
