import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const usingPrebuilt = process.env.SHIYE_PREBUILT === '1' || (
  !existsSync('apps/admin-web/src') && ['apps/api/dist/main.js', 'dist/admin-web/index.html', 'dist/user-web/index.html'].every(existsSync)
);

const steps = [
  ['install:check', ['run', 'install:check']],
  ['prisma:generate', ['run', 'prisma:generate']],
  ['prisma:migrate', ['run', 'prisma:migrate']],
  ['db:seed', ['run', 'db:seed', '--', '--create-only']],
  ...(usingPrebuilt ? [] : [
    ['build', ['run', 'build']],
    ['typecheck', ['run', 'typecheck']]
  ]),
  ['deploy:check', ['run', 'deploy:check']]
];

if (usingPrebuilt) console.log('Using prebuilt runtime package; skipping build and typecheck.');

for (const [name, args] of steps) {
  console.log(`\n==> ${name}`);
  await run('npm', args);
}

writeFileSync('.panel-installed', `${new Date().toISOString()}\n`, { mode: 0o600 });
console.log('\n安装完成。宝塔 / 1Panel 请重启 Node.js 项目；手动部署可执行 npm start。');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}
