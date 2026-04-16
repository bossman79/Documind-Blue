/**
 * Rasterize a .dwg with the same pipeline as documind (cad2x / custom cmd / LibreOffice).
 * No LLM calls. Copies final oriented PNG(s) to tools/dwg-raster-preview/ for inspection.
 *
 * Usage: node scripts/raster-dwg-preview.cjs [path-to.dwg]
 * Default file: <repo>/31510194_acm_003_00.dwg
 */
const path = require("path");
const fs = require("fs-extra");
const os = require("os");
const { convertDwgToOrientedPngs } = require("../core/dist/utils.js");

async function main() {
  const root = path.join(__dirname, "..");
  const defaultDwg = path.join(root, "31510194_acm_003_00.dwg");
  const dwg = path.resolve(process.argv[2] || defaultDwg);
  if (!(await fs.pathExists(dwg))) {
    console.error("DWG not found:", dwg);
    process.exit(1);
  }

  const outDir = path.join(root, "tools", "dwg-raster-preview");
  await fs.ensureDir(outDir);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dwg-prev-"));

  try {
    console.error("[raster-dwg-preview] input:", dwg);
    console.error("[raster-dwg-preview] temp:", tempDir);
    const { totalSourceCount } = await convertDwgToOrientedPngs({
      localPath: dwg,
      tempDir,
      metadataOnly: false,
    });
    console.error("[raster-dwg-preview] source PNG count:", totalSourceCount);

    const files = (await fs.readdir(tempDir))
      .filter((f) => f.toLowerCase().endsWith(".png"))
      .sort();
    for (const f of files) {
      const dest = path.join(outDir, f);
      await fs.copy(path.join(tempDir, f), dest);
      const st = await fs.stat(dest);
      console.log(JSON.stringify({ out: dest, bytes: st.size }));
    }
    if (files.length === 0) {
      console.error("No PNG files in temp after conversion.");
      process.exit(1);
    }
  } finally {
    await fs.remove(tempDir).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
