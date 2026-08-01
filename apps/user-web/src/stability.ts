const recoveryKey = 'shiye:asset-recovery';
const recoveryWindowMs = 30_000;

export function installAssetRecovery() {
  const recover = () => {
    const lastRecovery = Number(sessionStorage.getItem(recoveryKey) || 0);
    if (Date.now() - lastRecovery < recoveryWindowMs) return;
    sessionStorage.setItem(recoveryKey, String(Date.now()));
    window.location.reload();
  };

  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    recover();
  });

  window.addEventListener('error', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLScriptElement || target instanceof HTMLLinkElement)) return;
    const source = target instanceof HTMLScriptElement ? target.src : target.href;
    if (source && /\/assets\//.test(source)) recover();
  }, true);
}
