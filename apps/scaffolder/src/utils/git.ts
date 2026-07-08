/**
 * Runs a git command synchronously in the given directory.
 * Returns whether the command succeeded and any captured stderr output.
 */
function runGit(cwd: string, args: string[]): { ok: boolean; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });

  return {
    ok: result.exitCode === 0,
    stderr: new TextDecoder().decode(result.stderr).trim(),
  };
}

/**
 * Initializes a new git repository and creates an initial commit.
 * Returns whether the repository was initialized and whether the initial
 * commit succeeded.
 */
export interface GitInitResult {
  committed: boolean;
  initialized: boolean;
  message?: string;
}

export function initGitRepo(targetDir: string): GitInitResult {
  if (!runGit(targetDir, ["init"]).ok) {
    return { committed: false, initialized: false };
  }
  if (!runGit(targetDir, ["add", "-A"]).ok) {
    return { committed: false, initialized: true };
  }

  const commitResult = runGit(targetDir, [
    "commit",
    "-m",
    "chore: initial scaffold",
    "--allow-empty",
  ]);

  if (!commitResult.ok) {
    const missingIdentity =
      commitResult.stderr.includes("Author identity unknown") ||
      commitResult.stderr.includes("unable to auto-detect email address");

    return {
      committed: false,
      initialized: true,
      message: missingIdentity
        ? "Initial commit skipped: configure git user.name and user.email to enable automatic commits."
        : commitResult.stderr || undefined,
    };
  }

  return {
    committed: true,
    initialized: true,
  };
}
