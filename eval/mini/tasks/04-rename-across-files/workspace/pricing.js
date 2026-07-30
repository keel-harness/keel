const { calcTotal } = require("./cart");

// Apply a tax rate to the cart total.
function withTax(items, rate) {
  return calcTotal(items) * (1 + rate);
}

module.exports = { withTax };
