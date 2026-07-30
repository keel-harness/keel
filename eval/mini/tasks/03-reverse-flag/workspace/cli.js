const { format } = require("./format");

const args = process.argv.slice(2);
const items = args.filter((a) => !a.startsWith("--"));
const opts = {};
// TODO: parse flags (e.g. --reverse) into `opts` and pass them through to format().

process.stdout.write(format(items, opts) + "\n");
