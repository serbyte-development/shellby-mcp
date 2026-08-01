import { constants } from "node:fs";
import { access, lstat, mkdir, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_CODEX_BINARY =
  "/Applications/ChatGPT.app/Contents/Resources/codex";

export interface ApplyPatchSetup {
  binDirectory: string;
  executable: string;
  available: boolean;
  warning?: string;
}

export function resolveWorkspacePath(configured?: string): string {
  if (configured === undefined) {
    return join(homedir(), "Desktop", "chatgpt-workspace");
  }
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) {
    return join(homedir(), configured.slice(2));
  }
  return resolve(configured);
}

export async function prepareApplyPatch(
  workspace: string,
  codexBinary = DEFAULT_CODEX_BINARY,
): Promise<ApplyPatchSetup> {
  const binDirectory = join(workspace, "bin");
  const executable = join(binDirectory, "apply_patch");
  await mkdir(binDirectory, { recursive: true });

  try {
    await access(codexBinary, constants.X_OK);
  } catch (error) {
    return unavailable(
      binDirectory,
      executable,
      `Codex binary is not executable at ${codexBinary}: ${errorMessage(error)}`,
    );
  }

  try {
    await lstat(executable);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await symlink(codexBinary, executable);
  }

  try {
    await access(executable, constants.X_OK);
  } catch {
    const existing = await lstat(executable).catch(() => null);
    if (existing?.isSymbolicLink()) {
      await unlink(executable);
      await symlink(codexBinary, executable);
    }

    try {
      await access(executable, constants.X_OK);
    } catch (retryError) {
      return unavailable(
        binDirectory,
        executable,
        `apply_patch is not executable at ${executable}: ${errorMessage(retryError)}`,
      );
    }
  }

  return { binDirectory, executable, available: true };
}

function unavailable(
  binDirectory: string,
  executable: string,
  warning: string,
): ApplyPatchSetup {
  return { binDirectory, executable, available: false, warning };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
