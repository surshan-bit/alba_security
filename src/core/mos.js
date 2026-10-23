// Margin of safety in percent: how far the price sits below the intrinsic value, (intrinsic - price) / intrinsic. Negative when the price is
// above it. null when either figure is missing or the intrinsic value is not above zero. No imports, so the engines can use it too.
function marginOfSafety(intrinsic, price){
  return typeof intrinsic === 'number' && intrinsic > 0 && typeof price === 'number' && isFinite(price) ? ((intrinsic - price) / intrinsic) * 100 : null;
}

export { marginOfSafety };
