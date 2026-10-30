import { updateProgress } from './maintenance-core.mjs';
const [path, stage, value, message] = process.argv.slice(2);
if (path && stage) {
  const recovery = stage.startsWith('recovery:') ? stage.split(':')[1] : null;
  updateProgress(path, recovery ? { state: 'failed', message: '更新失败', recovery: { state: recovery, message } } : { stage, progress: Number(value), message });
}
