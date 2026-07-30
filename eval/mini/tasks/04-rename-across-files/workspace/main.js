const { calcTotal } = require("./cart");
const { withTax } = require("./pricing");

const items = [
  { price: 10, qty: 2 },
  { price: 5, qty: 1 },
];

console.log("total=" + calcTotal(items));
console.log("withTax=" + withTax(items, 0.5));
