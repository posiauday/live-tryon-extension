module.exports = {
  testDir: './tests',
  timeout: 30000,
  expect: {
    timeout: 10000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    headless: false,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
};
