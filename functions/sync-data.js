// Copies the latest data/questions.v2.json into functions/data/ so it gets bundled at deploy time.
// Runs as predeploy hook (see firebase.json).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'data', 'questions.v2.json');
const destDir = path.join(__dirname, 'data');
const dest = path.join(destDir, 'questions.v2.json');

if (!fs.existsSync(src)) {
  console.error(`[sync-data] source not found: ${src}`);
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
const size = (fs.statSync(dest).size / 1024 / 1024).toFixed(2);
console.log(`[sync-data] copied ${size} MB → functions/data/questions.v2.json`);
