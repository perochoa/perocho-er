// Settings the site and the worker each keep a copy of, checked against each other.

import assert from "node:assert/strict";
import { test } from "node:test";
import { site } from "../../src/site.ts";
import { wranglerVars } from "../scripts/wrangler-vars.ts";

test("the site quotes the rush fee the worker charges", () => {
	assert.equal(site.rushFee, wranglerVars().RUSH_FEE);
});
