// postinstall: renames electron.exe to Veil.exe and patches its PE version info
// so Task Manager shows "Veil" instead of "Electron". Uses resedit (pure Node.js)
// — no external exe, works without admin rights. Only runs on Windows. Idempotent.
//
// NOTE: earlier versions of this project disguised the process as
// "MicrosoftEdgeUpdate.exe" / "Microsoft Corporation" and stole Edge's icon.
// That impersonated a real company and tripped antivirus heuristics, so it was
// removed. Veil brands honestly as itself.

const fs   = require('fs');
const path = require('path');

if (process.platform !== 'win32') process.exit(0);

const DISPLAY_NAME = 'Veil.exe';
const distDir = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
const pathTxt = path.join(__dirname, '..', 'node_modules', 'electron', 'path.txt');
const target  = path.join(distDir, DISPLAY_NAME);

// ── Step 1: Get the source exe (original electron.exe or any previous alias) ─
const candidates = ['electron.exe', 'Veil.exe'];
let src = null;
for (const name of candidates) {
  const p = path.join(distDir, name);
  if (fs.existsSync(p)) { src = p; break; }
}

if (!src && fs.existsSync(target)) {
  console.log(`[postinstall] ${DISPLAY_NAME} already in place.`);
} else if (!src) {
  console.warn('[postinstall] No electron exe found — skipping.');
  process.exit(0);
} else if (path.basename(src) !== DISPLAY_NAME) {
  // Copy to new name (copy is not locked even if original is)
  fs.copyFileSync(src, target);
  console.log(`[postinstall] Copied ${path.basename(src)} -> ${DISPLAY_NAME}`);
  // Remove the source and any other leftover exe aliases (but never our target)
  const toDelete = [...candidates, 'electron.exe.bak']
    .filter((n) => n !== DISPLAY_NAME)
    .map((n) => path.join(distDir, n));
  for (const p of toDelete) {
    try { if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`[postinstall] Removed ${path.basename(p)}`); } }
    catch (_) { /* Defender may hold it — not fatal */ }
  }
}

// ── Step 2: Update path.txt ───────────────────────────────────────────────────
fs.writeFileSync(pathTxt, DISPLAY_NAME);
console.log(`[postinstall] path.txt -> ${DISPLAY_NAME}`);

// ── Step 3: Patch PE version info (retry a few times — Defender may scan briefly) ─
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function patchExe() {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const ResEdit = require('resedit');
      const { NtExecutable, NtExecutableResource, Resource } = ResEdit;
      const VersionInfo = Resource.VersionInfo;

      const exeBuffer = fs.readFileSync(target);
      const exe = NtExecutable.from(exeBuffer);
      const res = NtExecutableResource.from(exe);

      const viList = VersionInfo.fromEntries(res.entries);
      if (viList.length) {
        const vi = viList[0];
        for (const lang of vi.getAllLanguagesForStringValues()) {
          vi.setStringValues(lang, {
            FileDescription:  'Veil',
            ProductName:      'Veil',
            CompanyName:      'Veil',
            LegalCopyright:   'Copyright (c) Veil contributors. GPL-3.0-or-later.',
            OriginalFilename: 'Veil.exe',
            InternalName:     'Veil',
            FileVersion:      '1.0.0.0',
            ProductVersion:   '1.0.0.0',
          });
        }
        vi.fixedInfo.fileVersionMS    = 0x00010000;
        vi.fixedInfo.fileVersionLS    = 0x00000000;
        vi.fixedInfo.productVersionMS = 0x00010000;
        vi.fixedInfo.productVersionLS = 0x00000000;
        vi.outputToResourceEntries(res.entries);
      }

      res.outputResource(exe);
      fs.writeFileSync(target, Buffer.from(exe.generate()));
      console.log('[postinstall] Patched version info: "Veil"');
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < 5) await sleep(1500);
    }
  }
  console.warn(`[postinstall] Could not patch exe after 5 attempts: ${lastErr.message}`);
}

patchExe();
