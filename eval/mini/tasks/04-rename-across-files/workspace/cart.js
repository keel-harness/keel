// Sum the line-item prices (price * quantity) for a cart.
function calcTotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

module.exports = { calcTotal };
