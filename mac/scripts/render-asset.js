// Render a self-contained HTML file to a PNG (with alpha) at an exact pixel
// size, using Electron offscreen. Build-time tool only — never shipped.
//
//   npx electron scripts/render-asset.js <in.html> <out.png> <width> <height>
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');

const [htmlPath, outPath, w, h] = process.argv.slice(2);
if (!htmlPath || !outPath || !w || !h) {
  console.error('usage: electron render-asset.js <in.html> <out.png> <width> <height>');
  process.exit(1);
}

app.disableHardwareAcceleration();
// unique userData so several render processes can run concurrently
app.setPath('userData', require('node:os').tmpdir() + '/claudebrain-render-' + process.pid);
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: Number(w),
    height: Number(h),
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.setZoomFactor(1);
  await win.loadFile(htmlPath);
  // let canvas drawing / fonts / filters settle
  await new Promise((r) => setTimeout(r, 800));
  const image = await win.webContents.capturePage({
    x: 0,
    y: 0,
    width: Number(w),
    height: Number(h),
  });
  fs.writeFileSync(outPath, image.toPNG());
  const size = image.getSize();
  console.log(`${outPath} ${size.width}x${size.height}`);
  app.quit();
});
