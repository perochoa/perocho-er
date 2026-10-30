// The worker's plain vars from wrangler.jsonc, for the scripts and tests that run in Node.
// wrangler.jsonc only has whole-line comments, so dropping those leaves plain JSON.

import { readFileSync } from "node:fs";

export const wranglerVars = (): Record<string, unknown> =>
	JSON.parse(readFileSync(`${import.meta.dirname}/../wrangler.jsonc`, "utf8").replace(/^\s*\/\/.*$/gm, "")).vars;
