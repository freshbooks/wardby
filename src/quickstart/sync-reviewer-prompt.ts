/** `npm run sync:reviewer-prompt`: copies THOROUGH_REVIEWER_PROMPT into help/architecture-agent.md. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { withReviewerPrompt } from "./reviewer-prompt.js";

const article = fileURLToPath(new URL("../../help/architecture-agent.md", import.meta.url));
const before = readFileSync(article, "utf8");
const after = withReviewerPrompt(before);
if (after !== before) writeFileSync(article, after, "utf8");
console.log(after === before ? "help/architecture-agent.md is up to date." : "Updated help/architecture-agent.md.");
