export const DRIVER_AUDIT_CLIENT = 'reporting-v1';

export async function canOpenDriverAudits(serviceWorker) {
  if (!serviceWorker) return true;

  const controller = serviceWorker.controller;
  if (!controller) {
    const registration = await serviceWorker.getRegistration();
    return !registration && !serviceWorker.controller;
  }

  return new Promise(resolve => {
    const { port1, port2 } = new MessageChannel();
    const timer = setTimeout(() => finish(false), 1200);
    function finish(supported) {
      clearTimeout(timer);
      port1.close();
      resolve(supported && serviceWorker.controller === controller);
    }
    port1.onmessage = event => finish(event.data === DRIVER_AUDIT_CLIENT);
    try {
      controller.postMessage({ type: 'DRIVER_AUDIT_NETWORK_ONLY' }, [port2]);
    } catch {
      port2.close();
      finish(false);
    }
  });
}
