const fs = require('fs'); const path = require('path');
const requiredFiles = ['manifest.json','background/background.js','README.md','content/panel.js','camera/camera.html','camera/camera.css','camera/camera.js','src/decart-live.js','vendor/decart/decart-sdk.js','validation-checklist.js'];
const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(process.cwd(), file)));
if (missing.length) { console.error(`Missing required files:\n${missing.map((x) => `- ${x}`).join('\n')}`); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8')); if (manifest.manifest_version !== 3) throw new Error('Manifest must be MV3'); console.log('Project structure validation passed.');
