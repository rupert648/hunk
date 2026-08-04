import { spawnSync } from "node:child_process";

export const HUNK_PERSISTENT_TMUX_SESSION_ENV = "HUNK_PERSISTENT_TMUX_SESSION";

type SpawnSync = (
  command: string,
  args: string[],
  options: { stdio: "ignore" },
) => { status: number | null };

export function detachPersistentTmuxSession({
  env = process.env,
  spawn = spawnSync as SpawnSync,
}: {
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnSync;
} = {}) {
  const sessionName = env[HUNK_PERSISTENT_TMUX_SESSION_ENV]?.trim();
  if (!sessionName || !env.TMUX?.trim()) {
    return false;
  }

  return spawn("tmux", ["detach-client", "-s", sessionName], { stdio: "ignore" }).status === 0;
}
