"use client"

interface CatchingUpBannerProps {
  visible: boolean
}

export function CatchingUpBanner({ visible }: CatchingUpBannerProps) {
  if (!visible) return null

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-blue-600 px-4 py-1.5 text-xs font-medium text-white shadow-sm"
      role="status"
      aria-live="polite"
    >
      <svg
        className="h-3.5 w-3.5 animate-spin"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      Catching up — replaying missed events...
    </div>
  )
}
