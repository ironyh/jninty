// Line iteration + delimiter splitting for the source datasets.
// WFO classification.csv is quote-escaped CSV; the Dyntaxa DwC-A files are
// plain tab-delimited. Handles BOM and CRLF.
import fs from "node:fs";
import readline from "node:readline";

export async function* lines(path) {
  const rl = readline.createInterface({
    input: fs.createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let first = true;
  for await (const line of rl) {
    if (first) {
      first = false;
      yield line.replace(/^\uFEFF/, "");
      continue;
    }
    yield line;
  }
}

/** Split a delimited line honoring double-quoted fields (RFC 4180 style). */
export function splitDelimited(line, delimiter) {
  if (delimiter !== ",") return line.split(delimiter);
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
