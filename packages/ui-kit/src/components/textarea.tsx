import type * as React from "react";

import { cn } from "../lib/utils.ts";

/** shadcn's (new-york) textarea, with the same CI focus and invalid states as Input */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground bg-background flex min-h-16 w-full min-w-0 rounded-md border px-3 py-2 text-base shadow-xs transition-[color,border-color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        // CI §8: focus = a blue frame plus a blue-soft halo (the frame carries the 3:1)
        "focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-accent",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/12",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
