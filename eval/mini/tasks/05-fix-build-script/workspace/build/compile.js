// Write the UPPERCASE names of the ACTIVE items in data.json, one per line.
// (e.g. for the sample data the output is "ALPHA\nGAMMA".)
const fs = require("node:fs");
const path = require("node:path");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data.json"), "utf8"));
const names = data.items.filter((it) => it.active).map((it) => it.name.toUppercase());

process.stdout.write(names.join("\n") + "\n");
