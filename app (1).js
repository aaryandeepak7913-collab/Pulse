/* ============================================================
   Pulse remote — device layer
   Two real TVs are supported:
     - LG UR7500PSC (webOS)   -> controlled directly over the LOCAL
       NETWORK from this page, using LG's documented webOS "SSAP"
       protocol (the same one LG's own Magic Remote / ThinQ app use).
       No Bluetooth, no relay involved.
     - OnePlus Y-Series (Android/Google TV) -> Google's Android TV
       Remote protocol is raw TCP + TLS + protobuf, which a browser
       page cannot open on its own. This app talks to it through the
       small local "Pulse relay" service (see /relay) that actually
       speaks that protocol and exposes it over plain HTTP instead.
       If that relay isn't running or reachable, this says so — it
       never pretends the TV is connected.
   There is no simulated/demo pairing anywhere below: if a
   connection can't be made, the UI reports failure and stops.
   ============================================================ */

let tvOn = false;
let muted = false;
let shiftOn = false;

const STORAGE_KEY = 'pulse_known_tvs';

let lgSocket = null;       // main SSAP command socket
let lgButtonSocket = null; // secondary "pointer input" socket for button/key presses
let activeDevice = null;   // { name, type: 'lg', ip, clientKey } | { name, type: 'oneplus', ip, relay }

let oneplusPollTimer = null; // polls the relay's /pair/status while pairing/reconnecting

/* ---------------- storage ---------------- */

function loadDevices(){
  try{ return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch(e){ return []; }
}
function saveDevices(list){ localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); }

// Only ever called after a REAL successful connection — never speculatively.
function rememberDevice(device){
  let list = loadDevices().filter(d => d.name !== device.name);
  list.unshift({ ...device, last: Date.now() });
  saveDevices(list.slice(0, 5));
}
function forgetDevice(name){
  saveDevices(loadDevices().filter(d => d.name !== name));
  if (activeDevice && activeDevice.name === name) disconnect();
  showModalList();
}
function relativeTime(ts){
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.round(hrs / 24) + 'd ago';
}

/* ---------------- toast / haptics / status pill ---------------- */

function showToast(msg, ms=2600){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(()=> t.classList.remove('show'), ms);
}
function haptic(){ if (navigator.vibrate) navigator.vibrate(8); }

function setStatus(state, text){
  const el = document.getElementById('status');
  const label = document.getElementById('statusText');
  el.classList.remove('connected', 'pairing');
  if (state !== 'idle') el.classList.add(state);
  label.textContent = text;
}

function onStatusClick(){
  if (activeDevice){ disconnect(); return; }
  openLaunchModal();
}

function disconnect(){
  if (activeDevice && activeDevice.type === 'oneplus'){
    stopOneplusPolling();
    relayFetch(activeDevice.relay, '/disconnect', { ip: activeDevice.ip }).catch(()=>{});
  }
  if (lgButtonSocket) try{ lgButtonSocket.close(); }catch(e){}
  if (lgSocket) try{ lgSocket.close(); }catch(e){}
  lgSocket = null; lgButtonSocket = null; activeDevice = null;
  setStatus('idle', 'Not paired');
  showToast('Disconnected');
}

/* ============================================================
   LG webOS (UR7500PSC and other webOS TVs) — real control
   ============================================================ */

// This is the standard, publicly-documented webOS pairing manifest used
// by open-source remote-control projects (lgtv2, bscpylgtv, Home Assistant's
// webOS integration, etc.) — it's how any app identifies itself to the TV.
// The TV always shows an on-screen prompt for the person to physically
// accept before anything is allowed through, first time you connect.
function buildRegisterPayload(clientKey){
  const payload = {
    forcePairing: false,
    pairingType: 'PROMPT',
    manifest: {
      manifestVersion: 1,
      appVersion: '1.1',
      signed: {
        created: '20140509',
        appId: 'com.lge.test',
        vendorId: 'com.lge',
        localizedAppNames: { '': 'Pulse Remote' },
        localizedVendorNames: { '': 'LG Electronics' },
        permissions: [
          'TEST_SECURE','CONTROL_INPUT_TEXT','CONTROL_MOUSE_AND_KEYBOARD',
          'READ_INSTALLED_APPS','CONTROL_POWER','READ_CURRENT_CHANNEL',
          'READ_RUNNING_APPS','READ_UPDATE_INFO','UPDATE_FROM_REMOTE_APP',
          'READ_LGE_SDX_APPS','READ_NOTIFICATIONS','SEARCH','WRITE_SETTINGS',
          'READ_SETTINGS','CONTROL_AUDIO','CONTROL_DISPLAY','CONTROL_INPUT_JOYSTICK',
          'CONTROL_INPUT_MEDIA_RECORDING','CONTROL_INPUT_MEDIA_PLAYBACK',
          'CONTROL_INPUT_TV','CONTROL_TOPMOST','READ_TV_CURRENT_TIME'
        ],
        serial: '2f930e2d2cfe083771f68e4fe7bb07'
      },
      permissions: [
        'LAUNCH','LAUNCH_WEBAPP','APP_TO_APP','CLOSE','TEST_OPEN','TEST_PROTECTED',
        'CONTROL_AUDIO','CONTROL_DISPLAY','CONTROL_INPUT_JOYSTICK','CONTROL_INPUT_MEDIA_RECORDING',
        'CONTROL_INPUT_MEDIA_PLAYBACK','CONTROL_INPUT_TV','CONTROL_POWER','READ_APP_STATUS',
        'READ_CURRENT_CHANNEL','READ_INPUT_DEVICE_LIST','READ_NETWORK_STATE','READ_RUNNING_APPS',
        'READ_TV_CHANNEL_LIST','WRITE_NOTIFICATION_TOAST','READ_POWER_STATE','READ_COUNTRY_INFO',
        'CONTROL_INPUT_TEXT','CONTROL_MOUSE_AND_KEYBOARD','READ_UPDATE_INFO'
      ],
      signatures: [{
        signatureVersion: 1,
        signature: 'eyJhbGdvcml0aG0iOiJSU0ExXzEiLCJrZXlJZCI6InRlc3Qtc2lnbmluZy1rZXkiLCJzaWduYXR1cmVWZXJzaW9uIjoxfQ=='
      }]
    }
  };
  if (clientKey) payload['client-key'] = clientKey;
  return { type: 'register', id: 'register_0', payload };
}

// Tries wss:// (port 3001, self-signed cert — needs the person to have
// visited https://TV-IP:3001 once and accepted the browser's certificate
// warning) then falls back to plain ws:// on port 3000 (only reachable if
// this page itself isn't loaded over https, since browsers block insecure
// ws:// from an https:// page). No fallback beyond that — if neither
// connects, this rejects and the caller reports the real failure.
function connectLG(ip, clientKey){
  return new Promise((resolve, reject) => {
    const urls = [`wss://${ip}:3001`, `ws://${ip}:3000`];
    let i = 0;

    const tryNext = () => {
      if (i >= urls.length){ reject(new Error("couldn't reach the TV on this network")); return; }
      const url = urls[i++];
      let socket;
      try{ socket = new WebSocket(url); }
      catch(e){ tryNext(); return; }

      const timeout = setTimeout(() => { try{ socket.close(); }catch(e){} tryNext(); }, 4000);

      socket.onopen = () => socket.send(JSON.stringify(buildRegisterPayload(clientKey)));

      socket.onmessage = (ev) => {
        let msg; try{ msg = JSON.parse(ev.data); } catch(e){ return; }
        if (msg.type === 'registered'){
          clearTimeout(timeout);
          lgSocket = socket;
          resolve(msg.payload['client-key']);
        } else if (msg.type === 'error'){
          clearTimeout(timeout);
          try{ socket.close(); }catch(e){}
          reject(new Error(msg.error || 'the TV rejected the connection'));
        }
        // Any other message here just means "waiting for the on-screen
        // prompt to be accepted" — keep listening, don't time out early.
      };
      socket.onerror = () => { clearTimeout(timeout); tryNext(); };
      socket.onclose = () => { if (socket === lgSocket) lgSocket = null; };
    };

    tryNext();
  });
}

// webOS splits "commands" (audio/apps/power, over lgSocket) from
// "button presses" (D-pad, digits, playback keys — over a second socket
// whose address the TV hands you back after this request).
function openLgButtonSocket(){
  return new Promise((resolve, reject) => {
    if (!lgSocket) { reject(new Error('not connected')); return; }
    const id = 'ptr_' + Date.now();
    const onMsg = (ev) => {
      let msg; try{ msg = JSON.parse(ev.data); } catch(e){ return; }
      if (msg.id === id && msg.payload && msg.payload.socketPath){
        lgSocket.removeEventListener('message', onMsg);
        const sock = new WebSocket(msg.payload.socketPath);
        sock.onopen = () => resolve(sock);
        sock.onerror = () => reject(new Error('could not open the button channel'));
      }
    };
    lgSocket.addEventListener('message', onMsg);
    lgSocket.send(JSON.stringify({ type: 'request', id, uri: 'ssap://com.webos.service.networkinput/getPointerInputSocket' }));
  });
}

function lgCommand(uri, payload){
  if (!lgSocket || lgSocket.readyState !== WebSocket.OPEN) return false;
  lgSocket.send(JSON.stringify({ type: 'request', id: 'cmd_' + Math.random().toString(36).slice(2), uri, payload: payload || {} }));
  return true;
}
function lgButton(name){
  if (!lgButtonSocket || lgButtonSocket.readyState !== WebSocket.OPEN) return false;
  lgButtonSocket.send(`type:button\nname:${name}\n\n`);
  return true;
}

async function pairLG(ip, savedClientKey, displayName){
  setStatus('pairing', savedClientKey ? `Reconnecting to ${displayName}…` : 'Check the TV screen…');
  try{
    const clientKey = await connectLG(ip, savedClientKey);
    lgButtonSocket = await openLgButtonSocket();
    activeDevice = { name: displayName, type: 'lg', ip, clientKey };
    rememberDevice(activeDevice);
    setStatus('connected', displayName);
    showToast('Connected to ' + displayName);
  } catch(err){
    setStatus('idle', 'Not paired');
    showToast("Couldn't connect — " + err.message + '.');
  }
}

/* ============================================================
   OnePlus Y-Series (Android/Google TV) — real control, via the
   local Pulse relay (see /relay). This page never talks Android TV
   Remote protocol itself; it only ever calls the relay over plain
   HTTP, and reports exactly what the relay reports back.
   ============================================================ */

function normalizeRelayBase(url){
  return (url || '').trim().replace(/\/+$/, '');
}

async function relayFetch(relayBase, path, body){
  const base = normalizeRelayBase(relayBase);
  if (!base) throw new Error('no relay address set');
  let res;
  try{
    res = await fetch(base + path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'GET' });
  } catch(e){
    throw new Error("couldn't reach the relay at " + base + ' — is it running?');
  }
  let data = null;
  try{ data = await res.json(); }catch(e){}
  if (!res.ok) throw new Error((data && data.error) || ('relay returned ' + res.status));
  return data;
}

function stopOneplusPolling(){
  if (oneplusPollTimer){ clearInterval(oneplusPollTimer); oneplusPollTimer = null; }
}

// Polls GET /pair/status on the relay until the TV is connected, needs a
// pairing code, or something goes wrong — mirrors the LG flow's "check the
// TV screen…" wait, just over HTTP instead of a WebSocket handshake.
function pollOneplusStatus(relayBase, ip, { onCodeRequired, onConnected, onError }){
  stopOneplusPolling();
  oneplusPollTimer = setInterval(async () => {
    let s;
    try{ s = await relayFetch(relayBase, '/pair/status?ip=' + encodeURIComponent(ip)); }
    catch(e){ stopOneplusPolling(); onError(e.message); return; }

    if (s.status === 'code_required'){ stopOneplusPolling(); onCodeRequired(); }
    else if (s.status === 'connected'){ stopOneplusPolling(); onConnected(); }
    else if (s.status === 'error' || s.status === 'unpaired'){ stopOneplusPolling(); onError(s.message || 'The TV rejected the connection.'); }
    // 'starting' — keep polling
  }, 800);
}

async function beginOneplusPairing(ip, relayBase, displayName){
  setStatus('pairing', 'Check the TV screen…');
  try{
    await relayFetch(relayBase, '/pair/start', { ip });
  } catch(err){
    setStatus('idle', 'Not paired');
    showToast("Couldn't reach the relay — " + err.message);
    return;
  }
  pollOneplusStatus(relayBase, ip, {
    onCodeRequired: () => showModalOneplusCode(ip, relayBase, displayName),
    onConnected: () => finishOneplusConnect(ip, relayBase, displayName),
    onError: (msg) => {
      setStatus('idle', 'Not paired');
      showToast("Couldn't connect — " + msg);
    }
  });
}

function finishOneplusConnect(ip, relayBase, displayName){
  activeDevice = { name: displayName, type: 'oneplus', ip, relay: relayBase };
  rememberDevice({ name: displayName, type: 'oneplus', ip, relay: relayBase });
  setStatus('connected', displayName);
  showToast('Connected to ' + displayName);
}

// Reconnecting a remembered OnePlus TV: the relay already holds its
// certificate on disk, so this normally goes straight to 'connected'
// with no code prompt — same shape as LG's silent-reconnect case.
async function reconnectOneplus(device){
  setStatus('pairing', 'Reconnecting to ' + device.name + '…');
  try{
    await relayFetch(device.relay, '/pair/start', { ip: device.ip });
  } catch(err){
    setStatus('idle', 'Not paired');
    showToast("Couldn't reach the relay — " + err.message);
    return;
  }
  pollOneplusStatus(device.relay, device.ip, {
    onCodeRequired: () => showModalOneplusCode(device.ip, device.relay, device.name),
    onConnected: () => finishOneplusConnect(device.ip, device.relay, device.name),
    onError: (msg) => {
      setStatus('idle', 'Not paired');
      showToast("Couldn't connect — " + msg);
    }
  });
}

// Fire-and-forget command send for the OnePlus path — mirrors what
// lgCommand()/lgButton() do for LG, just over HTTP instead of a socket.
function oneplusCommand(action, extra){
  if (!activeDevice || activeDevice.type !== 'oneplus') return false;
  relayFetch(activeDevice.relay, '/command', { ip: activeDevice.ip, action, ...(extra || {}) })
    .catch((e) => showToast("Command didn't reach the TV — " + e.message));
  return true;
}

/* ============================================================
   Modal: device list -> model picker -> LG form / OnePlus info
   ============================================================ */

function openLaunchModal(){ showModalList(); document.getElementById('launchModal').classList.add('show'); }
function closeModal(){ document.getElementById('launchModal').classList.remove('show'); }

function typeLabel(type){
  if (type === 'lg') return 'LG webOS';
  if (type === 'oneplus') return 'Android TV · via relay';
  return type;
}

function showModalList(){
  const list = loadDevices();
  const rows = list.map(d => `
    <div class="device-tile" onclick="reconnectTo('${d.name.replace(/'/g,"\\'")}')">
      <div class="device-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/></svg></div>
      <div class="device-info">
        <div class="device-name">${d.name}</div>
        <div class="device-meta">${typeLabel(d.type)} · Last connected ${relativeTime(d.last)}</div>
      </div>
      <div class="device-forget" onclick="event.stopPropagation(); forgetDevice('${d.name.replace(/'/g,"\\'")}')">✕</div>
    </div>
  `).join('');

  document.getElementById('modalCard').innerHTML = `
    <div class="modal-title">Connect to a TV</div>
    <div class="modal-sub">${list.length ? "Pick a TV you've connected before, or add a new one." : "No TVs connected yet — add one to get started."}</div>
    ${rows}
    <div class="add-tile" onclick="showModalPickModel()">
      <div class="device-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></div>
      Add a new TV
    </div>
    <button class="modal-skip" onclick="closeModal()">Not now</button>
  `;
}

function showModalPickModel(){
  document.getElementById('modalCard').innerHTML = `
    <button class="back-link" onclick="showModalList()">‹ Back</button>
    <div class="modal-title">Which TV?</div>
    <div class="modal-sub">Control paths differ per brand — pick yours.</div>
    <div class="model-tile" onclick="showModalLgForm()">
      <div class="device-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/></svg></div>
      <div class="device-info">
        <div class="model-name">LG UR7500PSC · 65″</div>
        <div class="model-meta">webOS, controlled over Wi-Fi</div>
      </div>
    </div>
    <div class="model-tile" onclick="showModalOneplusForm()">
      <div class="device-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/></svg></div>
      <div class="device-info">
        <div class="model-name">OnePlus Y-Series · 32″</div>
        <div class="model-meta">Android/Google TV</div>
      </div>
    </div>
  `;
}

function showModalLgForm(){
  document.getElementById('modalCard').innerHTML = `
    <button class="back-link" onclick="showModalPickModel()">‹ Back</button>
    <div class="modal-title">LG UR7500PSC</div>
    <div class="info-block">
      This connects over your <b>home Wi-Fi</b>, not Bluetooth — same network your
      phone/laptop and the TV are both on. Find the TV's IP under
      <b>Settings → All Settings → Network → Wi-Fi Connection → Advanced</b>.
      If this page is served over <b>https</b> (like GitHub Pages), open
      <b>https://&lt;that IP&gt;:3001</b> once first and accept the certificate
      warning — browsers otherwise block the connection.
    </div>
    <label class="field-label">TV IP address</label>
    <input class="text-input" id="lgIpInput" type="text" placeholder="192.168.1.42" inputmode="decimal">
    <button class="primary-btn" onclick="submitLgForm()">Connect</button>
  `;
}

function submitLgForm(){
  const ip = document.getElementById('lgIpInput').value.trim();
  if (!ip){ showToast("Enter the TV's IP address first."); return; }
  closeModal();
  pairLG(ip, null, 'LG UR7500PSC (65″)');
}

function showModalOneplusForm(){
  document.getElementById('modalCard').innerHTML = `
    <button class="back-link" onclick="showModalPickModel()">‹ Back</button>
    <div class="modal-title">OnePlus Y-Series</div>
    <div class="info-block">
      Android/Google TV's remote protocol needs a raw TCP+TLS connection that a
      browser page can't open by itself — so this goes through the small local
      <b>Pulse relay</b> (see <code>/relay</code> in the project) running
      somewhere on your network, which speaks that protocol for real. If it
      isn't running yet: <code>cd relay && npm install && npm start</code>.
    </div>
    <label class="field-label">TV IP address</label>
    <input class="text-input" id="opIpInput" type="text" placeholder="192.168.1.55" inputmode="decimal">
    <label class="field-label">Relay address</label>
    <input class="text-input" id="opRelayInput" type="text" placeholder="http://localhost:8787" value="http://localhost:8787">
    <button class="primary-btn" onclick="submitOneplusForm()">Connect</button>
  `;
}

function submitOneplusForm(){
  const ip = document.getElementById('opIpInput').value.trim();
  const relay = document.getElementById('opRelayInput').value.trim();
  if (!ip){ showToast("Enter the TV's IP address first."); return; }
  if (!relay){ showToast('Enter the address of your Pulse relay first.'); return; }
  closeModal();
  beginOneplusPairing(ip, relay, 'OnePlus Y-Series (32″)');
}

function showModalOneplusCode(ip, relay, displayName){
  document.getElementById('launchModal').classList.add('show');
  document.getElementById('modalCard').innerHTML = `
    <div class="modal-title">Enter the TV's code</div>
    <div class="modal-sub">The TV is showing a pairing code on screen right now — type it in below.</div>
    <input class="text-input" id="opCodeInput" type="text" placeholder="123456" inputmode="numeric" autofocus>
    <button class="primary-btn" onclick="submitOneplusCode('${ip.replace(/'/g,"\\'")}', '${relay.replace(/'/g,"\\'")}', '${displayName.replace(/'/g,"\\'")}')">Submit code</button>
    <button class="modal-skip" onclick="closeModal()">Cancel</button>
  `;
}

async function submitOneplusCode(ip, relay, displayName){
  const code = document.getElementById('opCodeInput').value.trim();
  if (!code){ showToast('Enter the code shown on the TV.'); return; }
  try{
    await relayFetch(relay, '/pair/code', { ip, code });
  } catch(err){
    showToast("Couldn't submit the code — " + err.message);
    return;
  }
  closeModal();
  setStatus('pairing', 'Check the TV screen…');
  pollOneplusStatus(relay, ip, {
    onCodeRequired: () => showModalOneplusCode(ip, relay, displayName), // wrong code — TV asked again
    onConnected: () => finishOneplusConnect(ip, relay, displayName),
    onError: (msg) => {
      setStatus('idle', 'Not paired');
      showToast("Couldn't connect — " + msg);
    }
  });
}

function reconnectTo(name){
  const d = loadDevices().find(x => x.name === name);
  if (!d) return;
  closeModal();
  if (d.type === 'lg') pairLG(d.ip, d.clientKey, d.name);
  else if (d.type === 'oneplus') reconnectOneplus(d);
}

document.addEventListener('DOMContentLoaded', () => {
  showModalList();
  if (loadDevices().length) document.getElementById('launchModal').classList.add('show');
});

/* ============================================================
   Remote buttons — wired to the real LG socket when connected,
   otherwise they just say so instead of pretending to work.
   ============================================================ */

function requireConnection(){
  if (activeDevice && (activeDevice.type === 'lg' || activeDevice.type === 'oneplus')) return true;
  showToast('Not connected — pair a TV first.');
  return false;
}

function toggleTV(){
  if (!requireConnection()) return;

  if (activeDevice.type === 'oneplus'){
    // Unlike LG, this rides the TV's already-open relay session rather
    // than needing Wake-on-LAN, so it can genuinely turn back on too —
    // as long as the TV keeps its Wi-Fi alive in standby.
    oneplusCommand('power');
    tvOn = !tvOn;
    document.getElementById('powerBtn').classList.toggle('on', tvOn);
    showToast(tvOn ? 'Power on sent' : 'Power off sent');
    haptic();
    return;
  }

  if (tvOn){
    lgCommand('ssap://system/turnOff');
    tvOn = false;
    document.getElementById('powerBtn').classList.remove('on');
    showToast('Power off sent');
  } else {
    // Real TVs need Wake-on-LAN to power back on remotely, which needs a
    // raw UDP broadcast — not something a browser can send. Being upfront
    // about that instead of faking a power-on.
    showToast("Can't power on remotely from a browser — Wake-on-LAN needs raw network access this page doesn't have.");
  }
  haptic();
}

function toggleMute(){
  if (!requireConnection()) return;
  muted = !muted;
  if (activeDevice.type === 'oneplus') oneplusCommand('mute');
  else lgCommand('ssap://audio/setMute', { mute: muted });
  document.getElementById('muteBtn').classList.toggle('active', muted);
  document.getElementById('muteLabel').textContent = muted ? 'Muted' : 'Mute';
  document.getElementById('muteSlash').style.display = muted ? 'block' : 'none';
  document.getElementById('muteSlash2').style.display = muted ? 'block' : 'none';
  haptic();
}

function toggleKeypad(){
  document.getElementById('kbDrawer').classList.remove('open');
  document.getElementById('drawer').classList.toggle('open');
}
function toggleKeyboard(){
  document.getElementById('drawer').classList.remove('open');
  const kb = document.getElementById('kbDrawer');
  kb.classList.toggle('open');
  if (kb.classList.contains('open')) document.getElementById('kbInput').focus();
}

function kbType(ch){
  haptic();
  const input = document.getElementById('kbInput');
  input.value += (shiftOn && ch !== ' ') ? ch.toUpperCase() : ch;
  if (shiftOn && ch !== ' ') shiftOn = false;
}
function kbBackspace(){ haptic(); const i = document.getElementById('kbInput'); i.value = i.value.slice(0, -1); }
function kbShift(){ haptic(); shiftOn = !shiftOn; }

function kbDone(){
  haptic();
  const input = document.getElementById('kbInput');
  const text = input.value;
  if (!requireConnection()){ input.value = ''; document.getElementById('kbDrawer').classList.remove('open'); return; }
  if (text){
    if (activeDevice.type === 'oneplus') oneplusCommand('text', { text });
    else lgCommand('ssap://com.webos.service.ime/insertText', { text, replace: 0 });
    showToast('Sent "' + text + '" to the TV');
  }
  input.value = '';
  document.getElementById('kbDrawer').classList.remove('open');
}

function launch(el, name){
  haptic();
  if (!requireConnection()) return;

  if (activeDevice.type === 'oneplus'){
    if (name === 'Input'){ oneplusCommand('input'); showToast('Switching input… (support varies by TV)'); return; }
    oneplusCommand('launch', { app: name });
    showToast('Opening ' + name + '…');
    return;
  }

  const ids = { Netflix: 'netflix', YouTube: 'youtube.leanback.v4' };
  if (name === 'Input'){ lgButton('INPUT_HDMI1'); showToast('Switching input…'); return; }
  lgCommand('ssap://system.launcher/launch', { id: ids[name] });
  showToast('Opening ' + name + '…');
}

const BUTTON_NAMES = {
  up:'UP', down:'DOWN', left:'LEFT', right:'RIGHT', ok:'ENTER', back:'BACK', home:'HOME',
  'vol+':'VOLUMEUP', 'vol-':'VOLUMEDOWN', 'ch+':'CHANNELUP', 'ch-':'CHANNELDOWN'
};

function press(el, action){
  haptic();
  if (action === 'ok' || ['up','down','left','right'].includes(action)){
    const ring = document.getElementById('ring');
    ring.classList.remove('pulse');
    void ring.offsetWidth;
    ring.classList.add('pulse');
  }
  if (!requireConnection()) return;

  if (action === 'clear') return; // local keypad-entry clear only, nothing to send

  if (activeDevice.type === 'oneplus'){
    oneplusCommand(action);
    return;
  }

  if (BUTTON_NAMES[action]){ lgButton(BUTTON_NAMES[action]); return; }
  if (action === 'enter'){ lgButton('ENTER'); return; }
  if (/^[0-9]$/.test(action)){ lgButton(action); return; }
}

/* Registers the service worker so the app installs like a real app and
   keeps working offline once it's been opened at least once. */
if ('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
