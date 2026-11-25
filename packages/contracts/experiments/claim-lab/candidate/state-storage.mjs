import { readFile, stat } from "node:fs/promises";

export async function loadState({ statePath, maxBytes, fail, create }) {
  try {
    if ((await stat(statePath)).size > maxBytes) fail("journal state exceeds size limit");
    return { state: JSON.parse(await readFile(statePath, "utf8")), created: false };
  } catch (error) {
    if (error?.code !== "ENOENT") fail("invalid journal state");
    return { state: create(), created: true };
  }
}
