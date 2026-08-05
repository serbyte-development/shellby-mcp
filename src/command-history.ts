import { appendFileSync } from "node:fs";

export function createCommandHistoryRecorder(
  filePath: string,
  now: () => Date = () => new Date(),
): (command: string) => void {
  return (command: string) => {
    try {
      appendFileSync(
        filePath,
        `${compactTimestamp(now())}\t${JSON.stringify(command)}\n`,
        "utf8",
      );
    } catch (error) {
      console.warn(
        `Could not append agent command history: ${errorMessage(error)}`,
      );
    }
  };
}

export function compactTimestamp(date: Date): string {
  return [
    String(date.getFullYear()).slice(-2),
    twoDigits(date.getMonth() + 1),
    twoDigits(date.getDate()),
    "T",
    twoDigits(date.getHours()),
    twoDigits(date.getMinutes()),
    twoDigits(date.getSeconds()),
  ].join("");
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
