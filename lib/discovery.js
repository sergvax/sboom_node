/** Поиск колонок через mDNS (_staros._tcp) — опционально, нужен только для удобства. */
import { Bonjour } from 'bonjour-service';

/**
 * @param {number} timeoutMs
 * @returns {Promise<Array<{name:string,host:string,port:number,model:string|null,firmware:string|null,id:string|null}>>}
 */
export function discover(timeoutMs = 4000) {
  return new Promise((resolve) => {
    let bonjour;
    let browser;
    const found = new Map();
    const finish = () => {
      try {
        browser?.stop();
      } catch {
        /* ignore */
      }
      try {
        bonjour?.destroy();
      } catch {
        /* ignore */
      }
      resolve([...found.values()]);
    };

    try {
      bonjour = new Bonjour();
      browser = bonjour.find({ type: 'staros', protocol: 'tcp' }, (svc) => {
        const txt = svc.txt || {};
        const address =
          (svc.addresses || []).find((a) => a && a.includes('.') && !a.includes(':')) ||
          svc.referer?.address ||
          svc.host;
        if (!address) return;
        const key = txt.id || `${svc.name}:${address}:${svc.port}`;
        found.set(key, {
          name: txt.name || svc.name || 'SberBoom',
          host: address,
          port: svc.port || 20000,
          model: txt.type || null,
          firmware: txt.v || null,
          id: txt.id || null,
        });
      });
      browser.on?.('error', () => {});
      setTimeout(finish, timeoutMs);
    } catch {
      setTimeout(finish, 0);
    }
  });
}
