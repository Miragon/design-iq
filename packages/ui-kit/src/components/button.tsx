import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../lib/utils.ts";

/**
 * The CI focus ring (§8, §12): solid --ring with a gap in the page colour, so
 * it reads ≥ 3:1 on white AND next to a blue fill — the soft 50 % ring did
 * neither. Exported for the app's own controls (segmented switches, row links).
 */
const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** the hover lift of a filled action (CI §7): up a pixel, deeper shadow; down again while pressed */
const lift =
  "shadow-xs not-disabled:hover:-translate-y-px not-disabled:hover:shadow-md not-disabled:active:translate-y-0 not-disabled:active:shadow-xs";

// hover styles sit behind not-disabled: — a disabled button keeps its pointer
// events (its title still explains WHY it is off, the cursor says not-allowed)
// but never reacts. Not `enabled:`: an asChild <a> is neither, and must hover.
// A className that restyles the hover needs the same prefix (a bare hover:
// loses on specificity) — tailwind-merge then drops the variant's.
const buttonVariants = cva(
  `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 cursor-pointer ${focusRing}`,
  {
    variants: {
      variant: {
        default: `bg-primary text-primary-foreground not-disabled:hover:bg-primary-hover ${lift}`,
        destructive: `bg-destructive text-destructive-foreground ${lift}`,
        // the CI's secondary/ghost button: a quiet frame that turns blue on hover
        outline:
          "border bg-background text-foreground shadow-xs not-disabled:hover:border-primary not-disabled:hover:bg-accent not-disabled:hover:text-link",
        secondary: "bg-secondary text-secondary-foreground not-disabled:hover:bg-muted",
        ghost: "not-disabled:hover:bg-accent not-disabled:hover:text-accent-foreground",
        link: "text-link underline-offset-4 not-disabled:hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants, focusRing };
