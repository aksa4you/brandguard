# Bundled third-party code

These files are copied unmodified from npm and inlined into `dist/brandguard.html` by `scripts/build.js`
so the finished page makes no network requests.

| File | Library | Version | Licence | Used for |
| --- | --- | --- | --- | --- |
| `jszip.min.js` | JSZip | 3.10.1 | MIT or GPL-3.0 (used under MIT) | Reading text from `.docx` files |
| `pdf.min.js`, `pdf.worker.min.js` | pdf.js (`pdfjs-dist`) | 3.11.174 | Apache-2.0 | Reading text from `.pdf` files |

Licence texts: `JSZIP-LICENSE.md`, `PDFJS-LICENSE.txt`.
