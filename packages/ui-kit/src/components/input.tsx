import type * as React from "react";

import { cn } from "../lib/utils.ts";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "border-input selection:bg-primary selection:text-primary-foreground file:text-foreground placeholder:text-muted-foreground bg-background h-9 w-full min-w-0 rounded-md border px-3 py-1 text-base shadow-xs transition-[color,border-color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        // CI §8: focus = a blue frame plus a blue-soft halo (the frame carries the 3:1)
        "focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-accent",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/12",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
