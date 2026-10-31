import { Bonjour } from 'bonjour-service';
const b = new Bonjour();
const browser = b.find({ type: 'staros', protocol: 'tcp' }, (svc) => {
  console.log(JSON.stringify({ name: svc.name, fqdn: svc.fqdn, host: svc.host, port: svc.port, addresses: svc.addresses, txt: svc.txt, type: svc.type, protocol: svc.protocol, subtypes: svc.subtypes }, null, 2));
});
setTimeout(() => { try { browser.stop(); b.destroy(); } catch {} ; process.exit(0); }, 6000);
