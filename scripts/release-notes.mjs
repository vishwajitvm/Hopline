#!/usr/bin/env node
/**
 * Prints the release notes for one version: its CHANGELOG.md section plus download and install notes.
 * Used by the release workflow:  node scripts/release-notes.mjs 1.0.0 > release-notes.md
 */
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/release-notes.mjs <version>');
  process.exit(1);
}
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const start = changelog.indexOf(`## [${version}]`);
let section = 'See CHANGELOG.md for details.';
if (start >= 0) {
  const rest = changelog.slice(start);
  const next = rest.indexOf('\n## [', 1);
  section = (next >= 0 ? rest.slice(0, next) : rest).split('\n').slice(1).join('\n').trim();
  section = section.replace(/\n\[[^\]]+\]: https?:\/\/\S+/g, '').trim();
}

console.log(`**Hopline** is fast, private, peer-to-peer file transfer: files go straight from one device to another,
end-to-end encrypted and SHA-256 verified. Two desktop apps on the same network use **Direct mode** (measured 10 GiB
in 85 s). [README](https://github.com/vishwajitvm/Hopline#readme) · [Full changelog](https://github.com/vishwajitvm/Hopline/blob/main/CHANGELOG.md)

## What's new in ${version}

${section}

## Downloads

| Platform | File |
| --- | --- |
| Windows 10/11 (64-bit) | \`Hopline-Windows-x64-Setup.exe\` |
| macOS (Apple Silicon) | \`Hopline-macOS-arm64.dmg\` |
| macOS (Intel) | \`Hopline-macOS-x64.dmg\` |
| Linux (AppImage) | \`Hopline-Linux-x86_64.AppImage\` |
| Linux (Debian/Ubuntu) | \`Hopline-Linux-amd64.deb\` |

Verify a download with \`SHA256SUMS.txt\`.

### First launch

The installers are not code-signed yet:

- **Windows**: if SmartScreen appears, choose *More info → Run anyway*. The installer adds a firewall rule so
  Direct mode works on private networks.
- **macOS**: right-click the app → *Open* the first time. If macOS says the app is damaged, run
  \`xattr -cr /Applications/Hopline.app\`.
- **Linux**: \`chmod +x Hopline-Linux-x86_64.AppImage\` and run it, or \`sudo apt install ./Hopline-Linux-amd64.deb\`.
`);
