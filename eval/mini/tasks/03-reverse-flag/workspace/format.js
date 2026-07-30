// Format a list of items for display, one per line.
// `opts` is reserved for display options (e.g. ordering).
function format(items, opts = {}) {
  return items.join("\n");
}

module.exports = { format };
