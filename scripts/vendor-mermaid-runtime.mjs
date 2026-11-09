#!/usr/bin/env node
/**
 * Regenerate the tested native runtime from checksum-pinned Ubuntu packages.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const archive = 'https://archive.ubuntu.com/ubuntu/pool/main/';
const output = resolve(import.meta.dirname, '../src/mermaid-runtime/ubuntu-24.04-x64');
const packages = [
  ['libatk1.0-0t64', 'libatk-1.0.so.0', 'a/at-spi2-core/libatk1.0-0t64_2.52.0-1build1_amd64.deb', '42c5d4b00954f17c2c3c4b866844f691eb8b6d57bf08b59203e65f12dc84a4f9'],
  ['libatk-bridge2.0-0t64', 'libatk-bridge-2.0.so.0', 'a/at-spi2-core/libatk-bridge2.0-0t64_2.52.0-1build1_amd64.deb', '22b7d47e3c0f7953a78d3cfd309d1b20771085de9220fbe610c0989b9e808c9b'],
  ['libatspi2.0-0t64', 'libatspi.so.0', 'a/at-spi2-core/libatspi2.0-0t64_2.52.0-1build1_amd64.deb', 'd686ace4080eca9c2d6ce8de69392a5ac56c846701894c0858922d4ce341a1d7'],
  ['libxcomposite1', 'libXcomposite.so.1', 'libx/libxcomposite/libxcomposite1_0.4.5-1build3_amd64.deb', 'a12d5d9ae70b798cbbf284080eae32b87367561fc9c24492f641b8860ac0f308'],
  ['libxdamage1', 'libXdamage.so.1', 'libx/libxdamage/libxdamage1_1.1.6-1build1_amd64.deb', '6891faf325e996ebd28ef53ebb9c043dc96f67327500490affc3e89d366d35ed'],
  ['libxfixes3', 'libXfixes.so.3', 'libx/libxfixes/libxfixes3_6.0.0-2build1_amd64.deb', '0ee1015cccd063249e01c0cd0bf45f513c8ac9a1e5e485070c12e69192455e4a'],
  ['libxrandr2', 'libXrandr.so.2', 'libx/libxrandr/libxrandr2_1.5.2-2build1_amd64.deb', 'f2955a5e594f5724b58ad241d9231ea191cb36574a0d5e5ca6b661cd41d6256d'],
  ['libgbm1', 'libgbm.so.1', 'm/mesa/libgbm1_25.2.8-0ubuntu0.24.04.4_amd64.deb', '4bfe348b456db5b445a80e0a3ffb9e9a01b91499bb86e0e568ca3634b134da7e'],
  ['libasound2t64', 'libasound.so.2', 'a/alsa-lib/libasound2t64_1.2.11-1ubuntu0.3_amd64.deb', '5d17bfb5683eb99f1be951fe48e1be5bf3c52391913b6b74a8aecf9b4f5e779f'],
  ['libxrender1', 'libXrender.so.1', 'libx/libxrender/libxrender1_0.9.10-1.1build1_amd64.deb', 'd70bd831aebe8d4834b5dd2ed98df26dd6bd27f1042c47543bd7f66df1ae22ea'],
  ['libdrm2', 'libdrm.so.2', 'libd/libdrm/libdrm2_2.4.125-1ubuntu0.1~24.04.2_amd64.deb', '4d3e858dd57be617c49d87c5ddcdb35df744a4f0a559981256ae2ba174718584'],
  ['libxi6', 'libXi.so.6', 'libx/libxi/libxi6_1.8.1-1build1_amd64.deb', '0ea7acb5e8a8ce4d6653b30e03a319bfe136db7bfb5ee7cad34c2aa1272ea8d9'],
];
const sourcePackages = [
  ['a/at-spi2-core/', 'at-spi2-core_2.52.0-1build1.dsc', '16b82af63769eefb96343366f34545f2af2de5c3661c83293f50969de7fa450a'],
  ['a/alsa-lib/', 'alsa-lib_1.2.11-1ubuntu0.3.dsc', '0d259dcaefe6a5579e60da930d665480cfdb026278dc7440dfea9bbd4a8f8645'],
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const temporary = await mkdtemp(join(tmpdir(), 'codeman-mermaid-vendor-'));
const files = [];
const libraries = [];

async function download(url, hash) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${response.status} downloading ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== hash) throw new Error(`Checksum mismatch for ${url}`);
  return bytes;
}

async function record(path, bytes, url) {
  await mkdir(join(output, path.split('/')[0]), { recursive: true });
  await writeFile(join(output, path), bytes);
  files.push({ path, bytes: bytes.length, sha256: sha256(bytes), ...(url ? { url } : {}) });
}

try {
  const cached = process.argv[2] ? await readdir(resolve(process.argv[2])) : [];
  for (const [name, library, path, hash] of packages) {
    const url = archive + path;
    const local = cached.find((file) => file.startsWith(`${name}_`) && file.endsWith('.deb'));
    const bytes = local ? await readFile(join(resolve(process.argv[2]), local)) : await download(url, hash);
    if (sha256(bytes) !== hash) throw new Error(`Checksum mismatch for ${name}`);
    const deb = join(temporary, basename(path));
    const extracted = join(temporary, name);
    await writeFile(deb, bytes);
    execFileSync('dpkg-deb', ['-x', deb, extracted]);
    const version = execFileSync('dpkg-deb', ['-f', deb, 'Version'], { encoding: 'utf8' }).trim();
    await record(`lib/${library}`, await readFile(await realpath(join(extracted, 'usr/lib/x86_64-linux-gnu', library))));
    await record(`licenses/${name}.copyright`, await readFile(join(extracted, 'usr/share/doc', name, 'copyright')));
    libraries.push({ name: library, package: name, version, url, sha256: hash });
  }
  for (const name of ['GPL-2', 'LGPL-2', 'LGPL-2.1']) {
    await record(`licenses/${name}.txt`, await readFile(`/usr/share/common-licenses/${name}`));
  }
  for (const [path, name, hash] of sourcePackages) {
    const url = archive + path + name;
    const bytes = await download(url, hash);
    await record(`sources/${name}`, bytes, url);
    const block = bytes.toString('utf8').match(/^Checksums-Sha256:\n((?: .+\n)+)/m)?.[1];
    if (!block) throw new Error(`No source checksums in ${name}`);
    for (const line of block.trim().split('\n')) {
      const [sourceHash, , sourceName] = line.trim().split(/\s+/);
      if (!/^[a-zA-Z0-9_.+-]+$/.test(sourceName)) throw new Error('Invalid source filename');
      const sourceUrl = archive + path + sourceName;
      await record(`sources/${sourceName}`, await download(sourceUrl, sourceHash), sourceUrl);
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ target: 'ubuntu-24.04-x64', libraries, files }, null, 2) + '\n');
  console.log(`Vendored ${libraries.length} libraries with notices and corresponding source in ${output}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
