// Node's Math.log over many inputs (as exact double bits), for the Python js_log test.
const fs = require('fs');
const bits = (x) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(x);
  return b.toString('hex');
};
const inputs = [];
for (let i = 1; i <= 2000; i++) inputs.push(i);
for (let n = 1; n <= 300; n += 7) for (let df = 1; df <= n; df += 3) inputs.push(1 + (n - df + 0.5) / (df + 0.5));
let seed = 12345;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
for (let i = 0; i < 2000; i++) inputs.push(rnd() * 10 ** (rnd() * 12 - 6));
inputs.push(1e-310, 5e-324, 0.5, 2, Math.E, 1 + 2 ** -21, 1 - 2 ** -21, 1.0000001, 0.9999999, 1e308);
fs.writeFileSync(process.argv[2], JSON.stringify(inputs.map((x) => [bits(x), bits(Math.log(x))])));
console.log(inputs.length, 'values');
