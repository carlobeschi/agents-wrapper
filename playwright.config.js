// @ts-check
const { defineConfig } = require('@playwright/test');

// The spec starts its own server on a spare port against fake agents, so no
// webServer block here.
module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  use: { headless: true },
  reporter: [['list']],
});
