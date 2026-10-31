import { Avatar, AvatarFallback, AvatarImage } from "@designiq/ui-kit/components/avatar";
import { Button, focusRing } from "@designiq/ui-kit/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@designiq/ui-kit/components/dropdown-menu";
import { Link, useParams } from "@tanstack/react-router";
import { LogOut } from "lucide-react";

import { MiragonComet } from "@/components/miragon-comet";
import type { Me } from "@/lib/api";
import { useConfig, useLogout } from "@/lib/queries";

const LOGO_CLASS = `flex items-center gap-2.5 rounded-sm ${focusRing}`;

export function AppHeader({ me }: { me?: Me }) {
  const logout = useLogout();
  // a LIVE_AUTH=none host has nothing to sign out of (ADR 0007)
  const canLogout = useConfig().data?.auth !== "none";
  // inside a repository, home is that repository, not the list of all of them
  // (#184); the route names it, so the logo never points at one left before
  const { owner, repo } = useParams({ strict: false });
  const logo = (
    <>
      <MiragonComet className="h-3 w-auto shrink-0" />
      <span className="flex items-baseline gap-2">
        <span className="text-lg font-semibold tracking-tight">designIQ</span>
        <span className="text-muted-foreground hidden text-xs sm:inline">Model together. AI at the table.</span>
      </span>
    </>
  );
  return (
    <header className="flex items-center gap-3 border-b px-5 py-3">
      {owner && repo ? (
        <Link
          to="/r/$owner/$repo"
          params={{ owner, repo }}
          // the current page only on the root overview: a folder or an editor lies under it
          activeOptions={{ exact: true }}
          aria-label={`designIQ: ${owner}/${repo} home`}
          className={LOGO_CLASS}
        >
          {logo}
        </Link>
      ) : (
        <Link to="/" aria-label="designIQ: all repositories" className={LOGO_CLASS}>
          {logo}
        </Link>
      )}
      <div className="flex-1" />
      <a
        href="https://design.miragon.ai"
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground hover:text-link hidden text-xs transition-colors sm:inline"
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
