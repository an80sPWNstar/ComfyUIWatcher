// No framework, no deps — runs every *.test.js in this directory in its own process,
// same convention as guiTOP's test/run.js.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js'));

let failed = 0;
for (const file of files) {
  const full = path.join(dir, file);
  try {
    execFileSync(process.execPath, [full], { stdio: 'inherit' });
    console.log(`PASS ${file}`);
  } catch {
    console.error(`FAIL ${file}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`${failed}/${files.length} test file(s) failed`);
  process.exit(1);
}
console.log(`All ${files.length} test file(s) passed`);
