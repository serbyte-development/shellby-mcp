import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const MAX_SKILL_BYTES = 256 * 1024;

const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SkillSummary {
  name: string;
  description?: string;
}

export interface LoadedSkill extends Record<string, unknown> {
  name: string;
  path: string;
  content: string;
}

export class SkillCatalogError extends Error {
  constructor(
    readonly code: "invalid_skill_name" | "unknown_skill" | "skill_too_large",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SkillCatalogError";
  }
}

export class SkillCatalog {
  constructor(readonly root: string) {}

  async list(signal?: AbortSignal): Promise<SkillSummary[]> {
    signal?.throwIfAborted();

    let entries;
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (isFsError(error, "ENOENT")) return [];
      throw error;
    }

    const summaries = await Promise.all(
      entries
        .filter((entry) => SKILL_NAME_PATTERN.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(async (entry): Promise<SkillSummary | undefined> => {
          signal?.throwIfAborted();
          try {
            const loaded = await this.read(entry.name, signal);
            const description = frontmatterValue(loaded.content, "description");
            return {
              name: entry.name,
              ...(description ? { description } : {}),
            };
          } catch (error) {
            if (
              error instanceof SkillCatalogError &&
              (error.code === "unknown_skill" || error.code === "skill_too_large")
            ) {
              return undefined;
            }
            throw error;
          }
        }),
    );

    return summaries.filter((summary): summary is SkillSummary => summary !== undefined);
  }

  async read(name: string, signal?: AbortSignal): Promise<LoadedSkill> {
    validateSkillName(name);
    signal?.throwIfAborted();

    const path = join(this.root, name, "SKILL.md");
    let fileStat;
    try {
      fileStat = await stat(path);
    } catch (error) {
      if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) {
        throw new SkillCatalogError(
          "unknown_skill",
          `Unknown skill ${JSON.stringify(name)}. Call skill_list to discover available skills.`,
          { cause: error },
        );
      }
      throw error;
    }

    if (!fileStat.isFile()) {
      throw new SkillCatalogError(
        "unknown_skill",
        `Unknown skill ${JSON.stringify(name)}. Call skill_list to discover available skills.`,
      );
    }
    if (fileStat.size > MAX_SKILL_BYTES) {
      throw new SkillCatalogError(
        "skill_too_large",
        `Skill ${JSON.stringify(name)} exceeds the ${MAX_SKILL_BYTES}-byte SKILL.md limit.`,
      );
    }

    const content = await readFile(path, { encoding: "utf8", signal });
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
      throw new SkillCatalogError(
        "skill_too_large",
        `Skill ${JSON.stringify(name)} exceeds the ${MAX_SKILL_BYTES}-byte SKILL.md limit.`,
      );
    }

    return { name, path, content };
  }
}

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name);
}

function validateSkillName(name: string): void {
  if (isValidSkillName(name)) return;
  throw new SkillCatalogError(
    "invalid_skill_name",
    "Skill names must start with an alphanumeric character and may contain only letters, numbers, dots, underscores, and hyphens.",
  );
}

function frontmatterValue(markdown: string, key: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.trim() === "---") break;

    const separator = line.indexOf(":");
    if (separator < 0 || line.slice(0, separator).trim() !== key) continue;
    return unquote(line.slice(separator + 1).trim());
  }
  return undefined;
}

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function isFsError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
