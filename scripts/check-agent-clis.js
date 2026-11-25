#!/usr/bin/env node
// Credential-free, opt-in discovery check. Never invokes a prompt or model.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'agents.json'), 'utf8'));
const names = [...new Set(config.agents
  .filter(agent => agent.type !== 'url' && Array.isArray(agent.headless))
  .map(agent => agent.headless[0]))];
const env = { PATH: process.env.PATH || '' };
const installed = name => env.PATH.split(path.delimiter).some(directory => {
  try {
    fs.accessSync(path.join(directory, name), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
});
let failed = false;

for (const name of names) {
  if (!installed(name)) {
    console.log(`SKIP ${name}: not installed`);
    continue;
  }

  for (const flag of ['--version', '--help']) {
    const result = spawnSync(name, [flag], {
      encoding: 'utf8',
      env,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    if (result.error || result.status !== 0) {
      failed = true;
      console.error(`FAIL ${name} ${flag}: ${result.error?.message || `exit ${result.status}`}`);
      if (output) console.error(output.slice(0, 1000));
    } else {
      console.log(`PASS ${name} ${flag}: ${output.split('\n')[0] || 'no output'}`);
    }
  }
}

if (failed) process.exitCode = 1;
