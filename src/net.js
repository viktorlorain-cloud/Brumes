/* Couche réseau : un « salon » par code de partie.
   - transport Supabase Realtime (broadcast + présence) pour le jeu en ligne ;
   - transport BroadcastChannel pour tester plusieurs onglets sur un même appareil. */
import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = 'https://qduelziqulwtlrnhqmpk.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_t7_QVA_HGujJ365auHQHNg_pt5KGOOy';

let sb = null;

/* handlers : { onMessage(msg), onPeers(ids[]) } — renvoie { send(msg), close() } */
export async function openRoom(code, me, handlers, transport = 'supabase') {
  if (transport === 'bc') return openBroadcastChannel(code, me, handlers);
  if (!sb) sb = createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { params: { eventsPerSecond: 20 } } });
  const ch = sb.channel(`brumes-${code}`, { config: { broadcast: { self: false, ack: false }, presence: { key: me.id } } });
  ch.on('broadcast', { event: 'msg' }, ({ payload }) => handlers.onMessage(payload));
  ch.on('presence', { event: 'sync' }, () => handlers.onPeers(Object.keys(ch.presenceState())));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Délai dépassé')), 12000);
    ch.subscribe(async status => {
      if (status === 'SUBSCRIBED') { clearTimeout(timer); await ch.track({ id: me.id, name: me.name }); resolve(); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(timer); reject(new Error(status)); }
    });
  });
  return {
    send: msg => ch.send({ type: 'broadcast', event: 'msg', payload: msg }),
    close: () => sb.removeChannel(ch),
  };
}

function openBroadcastChannel(code, me, handlers) {
  const bc = new BroadcastChannel(`brumes-${code}`);
  const seen = new Map();
  const peers = () => { const now = Date.now(); const ids = [me.id, ...[...seen].filter(([, t]) => now - t < 3500).map(([id]) => id)]; handlers.onPeers(ids); };
  bc.onmessage = e => {
    const m = e.data;
    if (m.__beat) { const isNew = !seen.has(m.id); seen.set(m.id, Date.now()); if (isNew) peers(); return; }
    if (m.__bye) { seen.delete(m.id); peers(); return; }
    handlers.onMessage(m);
  };
  const beat = setInterval(() => { bc.postMessage({ __beat: true, id: me.id }); peers(); }, 1000);
  bc.postMessage({ __beat: true, id: me.id }); peers();
  return Promise.resolve({
    send: msg => bc.postMessage(JSON.parse(JSON.stringify(msg))),
    close: () => { bc.postMessage({ __bye: true, id: me.id }); clearInterval(beat); bc.close(); },
  });
}
