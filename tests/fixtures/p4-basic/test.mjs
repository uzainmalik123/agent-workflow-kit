import assert from "node:assert";
assert.strictEqual(1 + 1, 2);
assert.strictEqual("Hello, " + "World!", "Hello, World!");
const sum = [1, 2, 3].reduce((a, b) => a + b, 0);
assert.strictEqual(sum, 6);
console.log("All tests passed!");