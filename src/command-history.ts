import { appendFileSync } from "node:fs";

export function createCommandHistoryRecorder(filePath: string, now: () => Date = () => new Date()): (command: string) => void {
	return (command: string) => {
		try {
			appendFileSync(filePath, `${compactTimestamp(now())}\t${JSON.stringify(command)}\n---\n`, "utf8");
		} catch (error) {
			console.warn(`Could not append agent command history: ${errorMessage(error)}`);
		}
	};
}

export function compactTimestamp(date: Date): string {
	return [
		twoDigits(date.getDate()), // DD
		twoDigits(date.getMonth() + 1), // MM
		twoDigits(date.getSeconds()), // SS
	].join("-");
}

function twoDigits(value: number): string {
	return String(value).padStart(2, "0");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
