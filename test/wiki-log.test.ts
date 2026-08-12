import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps the wiki maintenance log in chronological order", async () => {
	const log = await readFile(new URL("../wiki/log.md", import.meta.url), "utf8");
	const dates = [...log.matchAll(/^## \[(\d{4}-\d{2}-\d{2})\]/gm)].map((match) => match[1]);

	assert.ok(dates.length > 0, "expected at least one dated wiki log entry");
	for (let index = 1; index < dates.length; index += 1) {
		assert.ok(dates[index - 1] <= dates[index], `wiki log entry ${dates[index]} appears after ${dates[index - 1]}`);
	}
});
