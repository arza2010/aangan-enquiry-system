/**
 * Talk to the "Aangan Studio" voice agent from your browser (microphone), without a phone number.
 *   npm run vaani:talk        then open http://localhost:4177
 *
 * A tiny server on YOUR machine asks Vaani for a WebRTC session (POST /api/trigger-call/, medium "webrtc") and the page joins it
 * with LiveKit. Your Vaani API key stays in this script; the browser only receives a short-lived session token.
 * When the call ends Vaani fires `call_postprocessing` at the registered webhook, so the full app flow runs.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { createServer } from "node:http";

const key = process.env.VAANI_API_KEY;
const AGENT_ID = process.env.VAANI_AGENT_ID ?? "ab97bd25-99aa-4c50-9304-2f5a080b92e3";
const PORT = 4177;
if (!key) { console.error("VAANI_API_KEY is not set in .env.local"); process.exit(1); }

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Talk to Aangan Studio</title>
<style>
 body{font:16px/1.5 system-ui;max-width:560px;margin:8vh auto;padding:0 20px;color:#1d1b19;background:#f6f5f2}
 button{font:inherit;padding:12px 22px;border-radius:12px;border:0;background:#1f5f4a;color:#fff;font-weight:600;cursor:pointer}
 button.stop{background:#a3261f} button:disabled{opacity:.5} #log{margin-top:20px;padding:14px;background:#fff;border-radius:12px;min-height:90px;font-size:14px;white-space:pre-wrap}
 .muted{color:#6d6a64}
</style>
<h1>Aangan Studio voice agent</h1>
<p class="muted">Browser test. Allow the microphone when asked, then speak as a caller. Press End when you finish: the call then flows into the enquiry app.</p>
<p><button id="go">Start call</button> <button id="stop" class="stop" disabled>End call</button> <button id="audio" style="display:none;background:#9a5b00">Enable audio</button></p>
<div id="log">Ready.</div>
<script src="https://cdn.jsdelivr.net/npm/livekit-client/dist/livekit-client.umd.min.js"></script>
<script>
 const log = (m) => { const l = document.getElementById('log'); l.textContent += '\\n' + m; };
 let room;
 document.getElementById('go').onclick = async () => {
   document.getElementById('go').disabled = true; document.getElementById('log').textContent = 'Asking Vaani for a session…';
   try {
     const r = await fetch('/token', { method: 'POST' }); const s = await r.json();
     if (!r.ok) throw new Error(JSON.stringify(s));
     room = new LivekitClient.Room();
     room.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => { if (track.kind === 'audio') { const el = track.attach(); el.autoplay = true; el.playsInline = true; document.body.appendChild(el); el.play().catch(() => {}); log('Agent audio connected.'); } });
     // Browsers can block audio that starts without a click; LiveKit tells us and a click re-enables it.
     room.on(LivekitClient.RoomEvent.AudioPlaybackStatusChanged, () => { document.getElementById('audio').style.display = room.canPlaybackAudio ? 'none' : 'inline-block'; if (!room.canPlaybackAudio) log('The browser blocked the agent audio: click "Enable audio".'); });
     room.on(LivekitClient.RoomEvent.ParticipantConnected, (p) => log('Joined: ' + p.identity));
     room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (p) => log('Left: ' + p.identity));
     room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (t) => log('Agent audio track stopped (' + t.kind + ')'));
     room.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (sp) => { const n = sp.map((x) => x.identity === room.localParticipant.identity ? 'you' : 'agent').join('+'); if (n && n !== window.__last) { window.__last = n; log('speaking: ' + n); } });
     room.on(LivekitClient.RoomEvent.Disconnected, (reason) => { log('Disconnected, reason code: ' + reason + '. Call ended. Check the front desk Telegram group in about a minute.'); document.getElementById('stop').disabled = true; document.getElementById('go').disabled = false; });
     await room.connect(s.connection_url, s.token);
     await room.startAudio().catch(() => {});
     await room.localParticipant.setMicrophoneEnabled(true);
     log('Connected (room ' + s.room_name + '). Speak now.'); document.getElementById('stop').disabled = false;
   } catch (e) { log('Could not start: ' + e.message); document.getElementById('go').disabled = false; }
 };
 document.getElementById('stop').onclick = () => room && room.disconnect();
 document.getElementById('audio').onclick = async () => { await room.startAudio(); document.getElementById('audio').style.display = 'none'; log('Audio enabled.'); };
</script>`;

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return void res.end(PAGE); }
    if (req.method === "POST" && req.url === "/token") {
      const r = await fetch("https://api.vaanivoice.ai/api/trigger-call/", {
        method: "POST",
        headers: { "X-API-Key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: AGENT_ID, medium: "webrtc", primary_language: "en", welcome_message: "Hello, Aangan Studio. How can I help you today?", welcome_interruptible: true }),
      });
      const j = (await r.json().catch(() => ({}))) as { token?: string; connection_url?: string; room_name?: string };
      console.log(`session request -> HTTP ${r.status}, room ${j.room_name ?? "-"}`);
      res.writeHead(r.ok ? 200 : 502, { "content-type": "application/json" });
      return void res.end(JSON.stringify(r.ok ? { token: j.token, connection_url: j.connection_url, room_name: j.room_name } : j));
    }
    res.writeHead(404).end();
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e) }));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Open http://localhost:${PORT} in your browser (Ctrl+C to stop)`));
