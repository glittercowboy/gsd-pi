import { useEffect } from "react";
import { cn } from "@/lib/utils";

export interface LogoAnimationProps {
  className?: string;
  onComplete?: () => void;
  size?: "sm" | "lg";
}

const SIZE_CLASSES = {
  sm: "h-8 w-8",
  lg: "h-32 w-32",
} as const;

/**
 * Pure render function for the brand logo image.
 * Exported for direct-call testing (no hooks).
 */
export function LogoAnimationView({
  className,
  size = "lg",
}: Omit<LogoAnimationProps, "onComplete">) {
  return (
    <img
      src="/assets/gsd-2-mission-control-logo.png"
      alt="GSD Logo"
      className={cn(SIZE_CLASSES[size], className)}
    />
  );
}

/**
 * Animated GSD logo using the official brand asset.
 * Fires onComplete after 600ms to drive initialization sequencing.
 */
export function LogoAnimation({
  className,
  onComplete,
  size = "lg",
}: LogoAnimationProps) {
  useEffect(() => {
    if (!onComplete) return;
    const timer = setTimeout(onComplete, 600);
    return () => clearTimeout(timer);
  }, [onComplete]);

  return <LogoAnimationView className={className} size={size} />;
}
