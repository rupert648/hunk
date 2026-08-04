import { describe, expect, test } from "bun:test";
import {
  detachPersistentTmuxSession,
  HUNK_PERSISTENT_TMUX_SESSION_ENV,
} from "./persistentTmuxSession";

describe("detachPersistentTmuxSession", () => {
  test("does nothing outside a configured tmux session", () => {
    let spawnCalls = 0;

    expect(
      detachPersistentTmuxSession({
        env: {},
        spawn: () => {
          spawnCalls += 1;
          return { status: 0 };
        },
      }),
    ).toBe(false);
    expect(spawnCalls).toBe(0);
  });

  test("detaches every client from the configured persistent session", () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    expect(
      detachPersistentTmuxSession({
        env: {
          TMUX: "/tmp/tmux.sock,1,0",
          [HUNK_PERSISTENT_TMUX_SESSION_ENV]: "hunk-worktree",
        },
        spawn: (command, args) => {
          calls.push({ command, args });
          return { status: 0 };
        },
      }),
    ).toBe(true);
    expect(calls).toEqual([
      {
        command: "tmux",
        args: ["detach-client", "-s", "hunk-worktree"],
      },
    ]);
  });

  test("falls back to a normal quit when detach fails", () => {
    expect(
      detachPersistentTmuxSession({
        env: {
          TMUX: "/tmp/tmux.sock,1,0",
          [HUNK_PERSISTENT_TMUX_SESSION_ENV]: "hunk-worktree",
        },
        spawn: () => ({ status: 1 }),
      }),
    ).toBe(false);
  });
});
