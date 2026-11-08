// data/site-mode.json, read the same way by server.js and the site build.
// S26 (audit, 7 Nov 2026): if the file can't be read or parsed, or "beta" isn't
// a true/false value, the site is in beta (browse only, no orders). Fail closed.
import { readFileSync } from "node:fs";

export function readSiteMode(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { mode: { beta: true }, problem: `data/site-mode.json can't be read (${e.code ?? e.name}): treated as beta, no orders` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { mode: { beta: true }, problem: "data/site-mode.json isn't an object: treated as beta, no orders" };
  }
  if (typeof raw.beta !== "boolean") {
    return { mode: { ...raw, beta: true }, problem: "data/site-mode.json has no true/false beta: treated as beta, no orders" };
  }
  return { mode: raw, problem: null };
}
