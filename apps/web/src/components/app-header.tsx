import { Avatar, AvatarFallback, AvatarImage } from "@designiq/ui-kit/components/avatar";
import { Button } from "@designiq/ui-kit/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@designiq/ui-kit/components/dropdown-menu";
import { Link } from "@tanstack/react-router";
import { LogOut } from "lucide-react";

import { MiragonComet } from "@/components/miragon-comet";
import type { Me } from "@/lib/api";
import { useConfig, useLogout } from "@/lib/queries";

export function AppHeader({ me }: { me?: Me }) {
  const logout = useLogout();
  // a LIVE_AUTH=none host has nothing to sign out of (ADR 0007)
  const canLogout = useConfig().data?.auth !== "none";
  return (
    <header className="flex items-center gap-3 border-b px-5 py-3">
      <Link to="/" className="flex items-center gap-2.5">
        <MiragonComet className="h-3 w-auto shrink-0" />
        <span className="flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-tight">designIQ</span>
          <span className="text-muted-foreground hidden text-xs sm:inline">Model together. AI at the table.</span>
        </span>
      </Link>
      <div className="flex-1" />
      <a
        href="https://design.miragon.ai"
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground hover:text-foreground hidden text-xs transition-colors sm:inline"
      >
        design.miragon.ai
      </a>
      {me && (
        // one menu behind the avatar: who is signed in, and Logout (#213)
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="rounded-full" aria-label={`Account @${me.user.login}`}>
              <Avatar className="size-7">
                {me.user.avatarUrl && <AvatarImage src={me.user.avatarUrl} alt="" />}
                <AvatarFallback>{me.user.login.slice(0, 2).toUpperCase()}</AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuLabel className="flex flex-col">
              {me.user.name && me.user.name !== me.user.login && <span>{me.user.name}</span>}
              <span className="text-muted-foreground text-xs font-normal">@{me.user.login}</span>
            </DropdownMenuLabel>
            {canLogout && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => logout.mutate()}>
                  <LogOut /> Logout
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </header>
  );
}
