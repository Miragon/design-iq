/**
 * The bench's controls in front of the board's toolbar: which sample board and which strategy.
 * Both are URL parameters of board-spike.html, and the page loads anew (the state is in memory only).
 */
import { useBoardContext } from "../../notations/board/board-context.tsx";
import { benchParams, BOARDS } from "../samples.ts";
import { STRATEGIES } from "../shared.ts";

/** a parameter of board-spike.html changes and the page loads anew */
function reload(name: "board" | "strategy", value: string): void {
  const url = new URL(location.href);
  url.searchParams.set(name, value);
  // node ids and positions belong to the board they were written for
  if (name === "board") for (const stale of ["arm", "zoom", "x", "y"]) url.searchParams.delete(stale);
  location.assign(url);
}

export function ToolbarLead() {
  const params = benchParams(useBoardContext().params);
  return (
    <>
      <label>
        Board
        <select value={params.board} onChange={(event) => reload("board", event.target.value)}>
          {BOARDS.map((board) => (
            <option key={board}>{board}</option>
          ))}
        </select>
      </label>
      <label>
        Strategy
        <select
          value={params.strategy}
          // the compare board shows every strategy side by side
          disabled={params.board === "compare"}
          onChange={(event) => reload("strategy", event.target.value)}
        >
          {STRATEGIES.map((strategy) => (
            <option key={strategy}>{strategy}</option>
          ))}
        </select>
      </label>
    </>
  );
}
