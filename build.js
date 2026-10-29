/* Builds dist/brandguard.html: one self-contained file with no network requests.
 * Third-party code (JSZip, pdf.js) is bundled from vendor/ - see vendor/README.md for licences. */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const read = (dir, f) => fs.readFileSync(path.join(root, dir, f), 'utf8');
// A literal "</script" inside inlined code would end the tag early.
const safe = (s) => s.replace(/<\/script/gi, '<\\/script');
const html = `<title>BrandGuard Review</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${read('src', 'app.css')}
</style>
<div id="app"></div>
<script>
${safe(read('vendor', 'jszip.min.js'))}
</script>
<script>
${safe(read('vendor', 'pdf.min.js'))}
</script>
<script>
${safe(read('vendor', 'pdf.worker.min.js'))}
;if (!globalThis.pdfjsWorker && globalThis.WorkerMessageHandler) globalThis.pdfjsWorker = { WorkerMessageHandler: globalThis.WorkerMessageHandler };
</script>
<script>
${safe(read('src', 'kit.js'))}
</script>
<script>
${safe(read('src', 'engine.js'))}
</script>
<script>
${safe(read('src', 'app.js'))}
</script>
`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'brandguard.html'), html);
console.log('built', (html.length / 1024).toFixed(1) + ' KB');
