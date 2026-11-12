#!/usr/bin/env node
// Prints the project report and the slides to PDF with Chromium (Playwright).
// Usage: node scripts/make-pdfs.mjs [output folder]   (default: docs/print/out)
// To use an installed Chrome: PLAYWRIGHT_CHANNEL=chrome node scripts/make-pdfs.mjs <folder>
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const printDir = join(here, '..', 'docs', 'print');
const outDir = resolve(process.argv[2] || join(printDir, 'out'));
mkdirSync(outDir, { recursive: true });

const SLIDE_ORDER = ['cover', 'problem', 'questions', 'architecture', 'hardware', 'edge', 'protocols', 'signed',
  'dashboard', 'answers', 'results', 'team', 'close'];
// Images the slides reference by their upload address in the slide tool.
const SLIDE_IMAGES = {
  '/_blob/604380df9bfc069dbfb16000d5e111e2': join(printDir, 'images', 'dashboard-live.png'),
  '/_blob/28239206eb961a159d912fe14c468f6a': join(printDir, 'images', 'performance-panel.png')
};

function styleValue(style, name) {
  const match = style.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`));
  return match ? match[1].trim() : '';
}

// The slide tool's block arrows, drawn as plain SVG of the same size and colour.
function arrowSvg(kind, style) {
  const width = parseFloat(styleValue(style, 'width')) || 24;
  const height = parseFloat(styleValue(style, 'height')) || 40;
  const fill = styleValue(style, 'background') || '#6F7C87';
  const path = kind === 'arrow-down'
    ? `M${width * 0.3} 0H${width * 0.7}V${height * 0.6}H${width}L${width / 2} ${height}L0 ${height * 0.6}H${width * 0.3}Z`
    : `M0 ${height * 0.3}H${width * 0.6}V0L${width} ${height / 2}L${width * 0.6} ${height}V${height * 0.7}H0Z`;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="flex:none;display:block"><path d="${path}" fill="${fill}"/></svg>`;
}

function slideHtml(id) {
  let html = readFileSync(join(printDir, 'slides', `${id}.html`), 'utf8');
  html = html.replace(/<aside>[\s\S]*?<\/aside>/g, '');
  html = html.replace(/<x-shape kind="(arrow-down|arrow-right)" style="([^"]*)"><\/x-shape>/g,
    (_, kind, style) => arrowSvg(kind, style));
  for (const [blob, file] of Object.entries(SLIDE_IMAGES)) {
    html = html.split(`src="${blob}"`).join(`src="data:image/png;base64,${readFileSync(file).toString('base64')}"`);
  }
  if (/<x-[a-z]/.test(html)) throw new Error(`slide ${id} still holds a slide-tool element`);
  return html;
}

const SLIDE_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>FlowState · Team 10 · Slides</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  @page { size: 1920px 1080px; margin: 0; }
  * { box-sizing: border-box; margin: 0; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; }
  section { width: 1920px; height: 1080px; position: relative; overflow: hidden; break-after: page; page-break-after: always; }
  section:last-of-type { break-after: auto; page-break-after: auto; }
  h1 { font-size: 96px; font-weight: 600; line-height: 1.1; }
  h2 { font-size: 64px; font-weight: 600; line-height: 1.15; }
  h3 { font-size: 44px; font-weight: 600; line-height: 1.2; }
  p { font-size: 32px; line-height: 1.4; }
  ul, ol { padding-left: 1.3em; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 0.35em 0.6em; text-align: left; vertical-align: top; border-bottom: 1px solid #D9DCD3; }
  th { font-weight: 600; border-bottom: 2px solid #11202B; }
  img { display: block; }
</style></head><body>
${SLIDE_ORDER.map(slideHtml).join('\n')}
</body></html>`;

const FOOTER = `<div style="width:100%;padding:0 17mm;font-family:Arial,sans-serif;font-size:7.5px;color:#7A858F;display:flex;justify-content:space-between">
<span>FlowState · Team 10 · Project report</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {});
try {
  const report = await browser.newPage();
  await report.goto(pathToFileURL(join(printDir, 'report.html')).href, { waitUntil: 'networkidle' });
  await report.evaluate(() => document.fonts.ready);
  const reportPath = join(outDir, 'FlowState_Team10_Project_Report.pdf');
  await report.pdf({
    path: reportPath,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate: FOOTER,
    margin: { top: '18mm', bottom: '20mm', left: '17mm', right: '17mm' }
  });
  console.log(`wrote ${reportPath}`);

  const slides = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await slides.setContent(SLIDE_PAGE, { waitUntil: 'networkidle' });
  await slides.evaluate(() => document.fonts.ready);
  const slidesPath = join(outDir, 'FlowState_Team10_Slides.pdf');
  await slides.pdf({ path: slidesPath, width: '1920px', height: '1080px', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  console.log(`wrote ${slidesPath} (${SLIDE_ORDER.length} slides)`);
} finally {
  await browser.close();
}
