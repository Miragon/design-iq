import { Outlet, useRouter } from "@tanstack/react-router";
import { CircleCheck, CircleX, Info, Loader2, TriangleAlert } from "lucide-react";
import { type CSSProperties, useEffect } from "react";
import { Toaster } from "sonner";

import { AppHeader } from "@/components/app-header";
import { useMe } from "@/lib/queries";
import { takeReturnTo } from "@/lib/return-to";
import { Login } from "@/routes/login";

/**
 * CI toasts (§8, §9): a popover surface, the status colour as a left edge AND
 * as a Lucide icon, the message in plain text — colour is never the only
 * signal. sonner injects its sheet UNLAYERED, so it outranks every Tailwind
 * utility (those live in @layer utilities): the surface goes through sonner's
 * own variables, and a utility that overrides one of its declarations is `!`.
 */
const TOASTER_STYLE = {
  fontFamily: "var(--designiq-font-sans)",
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--border-radius": "var(--cd-radius-md)",
} as CSSProperties;

const TOAST_ICONS = {
  success: <CircleCheck className="text-success size-4" />,
  error: <CircleX className="text-destructive size-4" />,
  warning: <TriangleAlert className="text-warning size-4" />,
  info: <Info className="text-info size-4" />,
  loading: <Loader2 className="text-muted-foreground size-4 animate-spin motion-reduce:animate-none" />,
};

const TOAST_CLASSES = {
  toast: "border-l-4! shadow-lg! focus-visible:ring-2 focus-visible:ring-ring",
  // a plain toast() is a hint, a loading one progress — both read as info
  default: "border-l-info!",
  loading: "border-l-info!",
  success: "border-l-success!",
  error: "border-l-destructive!",
  warning: "border-l-warning!",
  info: "border-l-info!",
  description: "text-muted-foreground!",
  actionButton:
    "bg-primary! text-primary-foreground! rounded-sm! font-semibold! hover:bg-primary-hover! focus-visible:ring-2! focus-visible:ring-ring focus-visible:ring-offset-2",
};

export function RootLayout() {
  const me = useMe();
  const router = useRouter();
  // the login callbacks land on "/" — pick the stashed deep link back up once
  // the session is real. Only on "/", so an explicit navigation never gets
  // hijacked; replace, so Back skips the intermediate overview.
  const restorable = Boolean(me.data) && window.location.pathname === "/";
  useEffect(() => {
    if (!restorable) return;
    const target = takeReturnTo();
    if (target) void router.history.replace(target);
  }, [restorable, router]);
  return (
    <div className="flex h-full flex-col">
      <AppHeader me={me.data} />
      <main className="min-h-0 flex-1">
        {me.isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="text-muted-foreground size-6 animate-spin" />
          </div>
        ) : me.isError || !me.data ? (
          <Login />
        ) : (
          <Outlet />
        )}
      </main>
      <Toaster
        position="bottom-center"
        style={TOASTER_STYLE}
        icons={TOAST_ICONS}
        toastOptions={{ classNames: TOAST_CLASSES }}
      />
    </div>
  );
}
