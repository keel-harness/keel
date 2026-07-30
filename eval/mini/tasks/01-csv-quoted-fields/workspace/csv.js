// Parse one CSV line into fields. See README.md for the rules.
// BUG: this naive split ignores quoting, so commas inside quoted fields are treated as separators.
function parseCsvLine(line) {
  return line.split(",");
}

module.exports = { parseCsvLine };
