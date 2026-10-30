import { api } from './api';

export function readUserNodes<T>(onSnapshot?: (nodes: T[]) => void): Promise<T[]> {
  let settled = false;
  const live = api<T[]>('/api/user/nodes');
  if (onSnapshot) {
    void api<T[]>('/api/user/nodes?snapshot=1').then(nodes => {
      if (!settled) onSnapshot(nodes);
    }).catch(() => undefined);
  }
  return live.then(nodes => { settled = true; return nodes; }, error => { settled = true; throw error; });
}
