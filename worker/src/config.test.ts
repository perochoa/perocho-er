// Settings the site and the worker each keep a copy of, checked against each other.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { site } from "../../src/site.ts";
import { wranglerVars } from "../scripts/wrangler-vars.ts";

const read = (path: string) => readFileSync(`${import.meta.dirname}/${path}`, "utf8");

test("the site quotes the rush fee the worker charges", () => {
	assert.equal(site.rushFee, wranglerVars().RUSH_FEE);
});

test("every outcome the worker redirects to has a page on the site", () => {
	const union = read("index.ts").match(/^type Outcome = (.+);$/m)?.[1];
	assert.ok(union, "no Outcome type in index.ts");
	const outcomes = [...union.matchAll(/"([^"]+)"/g)].map(([, outcome]) => outcome);
	const pages = [...read("../../src/pages/request/[outcome].astro").matchAll(/outcome: "([^"]+)"/g)].map(
		([, outcome]) => outcome,
	);
	assert.deepEqual(outcomes.sort(), pages.sort());
});
