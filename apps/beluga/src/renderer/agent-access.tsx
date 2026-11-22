/**
 * Agent access: whether an agent on this computer may control Beluga over MCP,
 * and the command that connects Claude Code. The key never reaches this page:
 * the main process puts the command on the clipboard itself.
 */
import { Button } from "@designiq/ui-kit/components/button";
import { cn } from "@designiq/ui-kit/lib/utils";
import { Copy, KeyRound } from "lucide-react";
import { useState } from "react";

import type { AgentInfo } from "../core/ipc.ts";
import { checkboxClass } from "./fields.tsx";

/** how long "Copied" stays */
const COPIED_MS = 2000;

export function AgentAccess({
  enabled,
  agent,
  disabled,
  onEnabled,
}: {
  enabled: boolean;
  agent: AgentInfo;
  disabled: boolean;
  onEnabled(enabled: boolean): void;
}) {
  const [said, setSaid] = useState<string | null>(null);
  const say = (text: string): void => {
    setSaid(text);
    setTimeout(() => setSaid(null), COPIED_MS);
  };

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 font-medium">Agent access</legend>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className={cn(checkboxClass, "mt-0.5")}
          checked={enabled}
          disabled={disabled}
          onChange={(e) => onEnabled(e.target.checked)}
        />
        <span>
          Let an agent on this computer control Beluga (MCP)
          <span className="text-muted-foreground block text-xs">
            It can set the glossary, start and stop listening and read the transcript. Only programs on this computer
            that have the key get in, so turn it on where nobody else logs in.
          </span>
        </span>
      </label>
      {enabled ? (
        <div className="flex flex-col gap-1.5 pl-6">
          {agent.state === "on" ? (
            <>
              <code className="text-muted-foreground font-mono text-xs break-all">{agent.url}</code>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() =>
                    void window.beluga.copyAgentCommand().then(
                      () => say("The command is on the clipboard. Run it in a terminal."),
                      () => say("The command could not be copied."),
                    )
                  }
                >
                  <Copy />
                  Copy the command for Claude Code
                </Button>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() =>
                    void window.beluga
                      .renewAgentKey()
                      .then(() => say("New key. Connect the agent again with the new command."))
                  }
                >
                  <KeyRound />
                  New key
                </Button>
              </div>
              {said ? (
                <p className="text-muted-foreground text-xs" role="status">
                  {said}
                </p>
              ) : null}
            </>
          ) : agent.state === "failed" ? (
            <p className="text-destructive text-xs" role="alert">
              The agent cannot reach Beluga. {agent.message}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">Opening…</p>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
