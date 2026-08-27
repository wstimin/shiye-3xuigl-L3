import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = resolve(root, '.release');
const stageRoot = resolve(releaseRoot, 'package');

const requiredPaths = [
  'package.json',
  'package-lock.json',
  'build-info.json',
  '.env.example',
  'apps/api/package.json',
  'apps/api/dist',
  'packages/shared/package.json',
  'packages/shared/dist',
  'packages/xui-client/package.json',
  'packages/xui-client/dist',
  'packages/payment-core/package.json',
  'packages/payment-core/dist',
  'dist/admin-web',
  'dist/user-web',
  'prisma/schema.prisma',
  'prisma/migrations',
  'infra',
  'install.sh'
];

const optionalPaths = ['uninstall.sh'];

const runtimeScripts = [
  'check-update-migrations.mjs',
  'deploy-check.mjs',
  'install-check.mjs',
  'install.mjs',
  'panel-start.mjs',
  'sync-admin.mjs'
];

const runtimeFiles = [
  'apps/api/dist/main.js',
  'packages/shared/dist/index.js',
  'packages/xui-client/dist/index.js',
  'packages/payment-core/dist/index.js',
  'dist/admin-web/index.html',
  'dist/user-web/index.html'
];

for (const path of [...requiredPaths, ...runtimeFiles]) requireSource(path);

rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });

for (const path of requiredPaths) copyPath(path);
for (const path of optionalPaths) {
  if (existsSync(resolve(root, path))) copyPath(path);
}

copyRuntimeScripts();
pruneBuildMetadata(stageRoot);
validateStage();

console.log(`Release package staged at ${relative(root, stageRoot)}`);

function requireSource(path) {
  if (!existsSync(resolve(root, path))) {
    throw new Error(`Required release file is missing: ${path}. Run a clean build first.`);
  }
}

function copyPath(path) {
  const source = resolve(root, path);
  const destination = resolve(stageRoot, path);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function copyRuntimeScripts() {
  const sourceDirectory = resolve(root, 'scripts');
  const destinationDirectory = resolve(stageRoot, 'scripts');
  mkdirSync(destinationDirectory, { recursive: true });

  for (const name of runtimeScripts) {
    const source = join(sourceDirectory, name);
    if (!existsSync(source)) throw new Error(`Required runtime script is missing: scripts/${name}`);
    cpSync(source, join(destinationDirectory, name));
  }
}

function pruneBuildMetadata(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      pruneBuildMetadata(path);
      continue;
    }
    if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.ts.map') || entry.name.endsWith('.js.map')) rmSync(path);
  }
}

function validateStage() {
  for (const path of runtimeFiles) {
    if (!existsSync(resolve(stageRoot, path))) throw new Error(`Staged runtime file is missing: ${path}`);
  }

  const forbiddenPaths = ['.env', 'node_modules', 'apps/admin-web', 'apps/user-web', 'tests'];
  for (const path of forbiddenPaths) {
    if (existsSync(resolve(stageRoot, path))) throw new Error(`Forbidden release content was staged: ${path}`);
  }

  validateRuntimeOnly(stageRoot);
}

function validateRuntimeOnly(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'src') throw new Error(`Source directory was staged: ${relative(stageRoot, path)}`);
      validateRuntimeOnly(path);
      continue;
    }
    if (extname(entry.name).toLowerCase() === '.md' || extname(entry.name).toLowerCase() === '.txt') {
      throw new Error(`Documentation file was staged: ${relative(stageRoot, path)}`);
    }
    if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.map')) {
      throw new Error(`Build metadata was staged: ${relative(stageRoot, path)}`);
    }
  }
}
