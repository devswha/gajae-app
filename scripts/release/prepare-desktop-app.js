#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const stageDir = path.join(rootDir, '.desktop-build', 'desktop-app');

const packageJson = JSON.parse(
  await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'),
);

function getElectronVersion() {
  try {
    return JSON.parse(
      readFileSync(path.join(rootDir, 'node_modules', 'electron', 'package.json'), 'utf8'),
    ).version;
  } catch {
    try {
      return JSON.parse(
        readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'),
      ).packages['node_modules/electron'].version;
    } catch {
      throw new Error('Could not resolve an exact Electron version for desktop packaging.');
    }
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyRequired(relativePath) {
  const from = path.join(rootDir, relativePath);
  const to = path.join(stageDir, relativePath);
  if (!(await pathExists(from))) {
    throw new Error(`Required desktop build input is missing: ${relativePath}`);
  }
  await fs.cp(from, to, { recursive: true });
}


async function copyProductionNodeModules() {
  const lockfile = JSON.parse(await fs.readFile(path.join(rootDir, 'package-lock.json'), 'utf8'));
  const packages = Object.entries(lockfile.packages || {})
    .filter(([relativePath, metadata]) => relativePath.startsWith('node_modules/') && !metadata.dev)
    .sort(([left], [right]) => left.split('/').length - right.split('/').length);

  for (const [relativePath, metadata] of packages) {
    const source = path.join(rootDir, relativePath);
    if (!(await pathExists(source))) {
      if (metadata.optional) continue;
      throw new Error(`Required production dependency is missing from node_modules: ${relativePath}`);
    }
    const target = path.join(stageDir, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(source, target, {
      recursive: true,
      filter: (entry) => entry === source || !path.relative(source, entry).startsWith(`node_modules${path.sep}`),
    });
  }

  return packages.map(([relativePath]) => relativePath);
}

// The desktop app versions independently of the upstream web package (gjc-desktop-vX.Y.Z
// releases; v0.1.0/v0.1.1 both shipped as internal 1.36.1 and were indistinguishable).
// Resolution: GJC_DESKTOP_VERSION env > package.json desktopVersion > web version.
const desktopVersion =
  process.env.GJC_DESKTOP_VERSION || packageJson.desktopVersion || packageJson.version;

function buildDesktopPackageJson() {
  return {
    name: `${packageJson.name}-desktop`,
    version: desktopVersion,
    productName: packageJson.productName,
    description: `${packageJson.productName} desktop shell`,
    author: packageJson.author,
    license: packageJson.license,
    type: 'module',
    main: 'electron/main.js',
    homepage: packageJson.homepage || 'https://gjc.vibetip.help',
    dependencies: packageJson.dependencies,
    build: {
      appId: packageJson.build.appId,
      productName: packageJson.build.productName,
      asar: packageJson.build.asar,
      artifactName: packageJson.build.artifactName,
      executableName: packageJson.build.executableName,
      electronVersion: getElectronVersion(),
      directories: {
        output: '../../release/desktop',
      },
      extraMetadata: {
        main: 'electron/main.js',
      },
      files: [
        'electron/**',
        'public/**',
        'dist/**',
        'dist-server/**',
        'dist-native/**',
        'shared/**',
        'server/**',
        'scripts/gajae-app-runtime.mjs',
        'node_modules/**',
        'package.json',
      ],
      protocols: packageJson.build.protocols,
      mac: packageJson.build.mac,
      win: packageJson.build.win,
      nsis: packageJson.build.nsis,
      linux: packageJson.build.linux,
    },
  };
}

await fs.rm(stageDir, { recursive: true, force: true });
await fs.mkdir(stageDir, { recursive: true });

for (const input of [
  'electron',
  'dist',
  'dist-server',
  'dist-native',
  'public',
  'shared',
  'server',
  'scripts/gajae-app-runtime.mjs',
]) {
  await copyRequired(input);
}

const copiedRuntimeDependencies = await copyProductionNodeModules();

await fs.writeFile(
  path.join(stageDir, 'package.json'),
  `${JSON.stringify(buildDesktopPackageJson(), null, 2)}\n`,
  'utf8',
);

console.log(`Prepared desktop server payload at ${path.relative(rootDir, stageDir)}`);
console.log(`Desktop version: ${desktopVersion} (web package ${packageJson.version})`);
console.log(`Production runtime dependencies: ${copiedRuntimeDependencies.join(', ')}`);
