// ---- __NAME__ (kit/__NAME__.js) ----
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'kit', '__NAME__.js'), 'utf8'), sandbox, { filename: '__NAME__.js' });
test('__NAME__: toWholeCount floors and never goes negative', () => {
  assert.strictEqual(Kit.__CAMEL__.toWholeCount(2.7), 2);
  assert.strictEqual(Kit.__CAMEL__.toWholeCount(-3.2), 0, 'negative counts clamp to zero');
});
