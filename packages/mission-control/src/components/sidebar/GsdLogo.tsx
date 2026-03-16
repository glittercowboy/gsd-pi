import { cn } from "@/lib/utils";

interface GsdLogoProps {
  className?: string;
}

/**
 * GSD brand logo rendered as an <img> tag pointing to the official asset.
 * Uses the transparent SVG variant so it works on dark backgrounds (sidebar).
 */
export function GsdLogo({ className }: GsdLogoProps) {
  return (
    <img
      src="/assets/gsd-2-mission-control-logo.png"
      alt="GSD"
      className={cn("h-8 w-8", className)}
    />
  );
}
