// Browser simulator: a straight road that scrolls with your car. Every vehicle and pedestrian carries a phone.
// The phones only talk through simulated Bluetooth broadcasts, using the real packet and mesh code.
import {M_PER_DEG, isRelevant, relayDelay, shouldRelay, track} from './mesh.js';
import {OBJECT, TYPE, TYPE_NAME, decode, encode, hex} from './packet.js';

const VIEW = 420; // metres of road on screen
const BEHIND = 60; // metres shown behind your car
const LANE_Y = [1.75, 5.25]; // lane centres, m north of the south kerb
const ROAD_W = 7;
const PATH_Y = [-2.2, 9.2]; // footpaths
const ORIGIN = {lat: 12.9172, lon: 77.6227}; // Silk Board junction, Bengaluru
const COS0 = Math.cos((ORIGIN.lat * Math.PI) / 180);
const HARD_BRAKE = 4.4; // m/s^2, 0.45 g held for 300 ms
const HEADING = 90; // traffic drives east
const KINDS = {
	car: {len: 4.5, wid: 1.8, vmax: [11, 14], object: OBJECT.CAR},
	bike: {len: 2, wid: 0.8, vmax: [10, 13], object: OBJECT.TWO_WHEELER},
	bus: {len: 11, wid: 2.5, vmax: [8.5, 10], object: OBJECT.BUS},
};
const TEXT = {
	en: {lang: 'en-IN', m: 'metres', [TYPE.EBA]: 'Car ahead braking hard', [TYPE.VRU_HERE]: 'Pedestrian crossing ahead'},
	hi: {lang: 'hi-IN', m: 'मीटर', [TYPE.EBA]: 'आगे गाड़ी ज़ोर से ब्रेक लगा रही है', [TYPE.VRU_HERE]: 'आगे पैदल यात्री सड़क पार कर रहा है'},
	kn: {lang: 'kn-IN', m: 'ಮೀಟರ್', [TYPE.EBA]: 'ಮುಂದೆ ವಾಹನ ಜೋರಾಗಿ ಬ್ರೇಕ್ ಹಾಕುತ್ತಿದೆ', [TYPE.VRU_HERE]: 'ಮುಂದೆ ಪಾದಚಾರಿ ರಸ್ತೆ ದಾಟುತ್ತಿದ್ದಾರೆ'},
};
const COL = {bg: '#15171A', path: '#191B1E', road: '#1E2125', line: '#2E3238', node: '#3A3F46', car: '#272B31', text: '#ECEBE7', sub: '#9BA1A8', mute: '#6C727A', acc: '#7CC39C', brake: '#D2584F'};

const rand = (a, b) => a + Math.random() * (b - a);
const u24 = () => Math.floor(Math.random() * 0xffffff);
const u32 = () => Math.floor(Math.random() * 0xffffffff);
const geo = (x, y) => ({lat: ORIGIN.lat + y / M_PER_DEG, lon: ORIGIN.lon + x / (M_PER_DEG * COS0)});

const S = {view: 0, t: 0, rate: 1, range: 90, lang: 'en', voice: true, links: true, nodes: [], events: [], rings: [], log: [], origins: new Map(), stats: {sent: 0, relays: 0, alerts: 0}, ego: null, egoAlert: null, spoken: {}};

// ---------- nodes ----------
const phone = () => ({sender: u24(), senderSince: 0, seen: new Set(), pending: new Map(), alertUntil: -1, alertAt: -9, alertAge: 0});

function vehicle(kind, x, lane) {
	const k = KINDS[kind];
	const vmax = rand(...k.vmax);
	return {kind, x, y: LANE_Y[lane], lane, len: k.len, wid: k.wid, vmax, v: vmax * rand(0.8, 1), active: true, braking: false, hardFor: 0, lastEba: -9, ...phone()};
}

const pedestrian = (x, side) => ({kind: 'ped', x, y: PATH_Y[side], v: 0, active: true, crossing: 0, nextBeacon: 0, ...phone()});

function populate() {
	S.ego = vehicle('car', BEHIND, 0);
	S.nodes = [S.ego];
	for (const lane of [0, 1])
		for (let x = lane ? 15 : BEHIND + 40; x < VIEW - 10; x += rand(30, 48)) {
			const r = Math.random();
			S.nodes.push(vehicle(lane === 1 && r < 0.18 ? 'bus' : r < 0.72 ? 'car' : 'bike', x, lane));
		}
	[55, 135, 210, 290, 360].forEach((x, i) => S.nodes.push(pedestrian(x, i % 2)));
}

// ---------- radio ----------
function schedule(at, fn) {
	const ev = {at, fn, cancelled: false};
	S.events.push(ev);
	return ev;
}

function transmit(n, bytes) {
	const m = decode(bytes);
	n.seen.add(m.msgId);
	S.stats.sent++;
	if (m.hop) S.stats.relays++;
	S.log.unshift({t: S.t, m, hex: hex(bytes)});
	S.log.length = Math.min(S.log.length, 12);
	S.rings.push({x: n.x, y: n.y, t0: S.t});
	for (const r of S.nodes) {
		if (r === n || !r.active) continue;
		const d = Math.hypot(r.x - n.x, r.y - n.y);
		if (d <= S.range) schedule(S.t + rand(0.1, 0.3), () => receive(r, bytes, d)); // BLE advert discovery
	}
}

function receive(r, bytes, d) {
	if (!r.active) return;
	const m = decode(bytes);
	if (r.seen.has(m.msgId)) {
		// Someone else relayed it first: stand down.
		const p = r.pending.get(m.msgId);
		if (p) p.cancelled = true;
		r.pending.delete(m.msgId);
		return;
	}
	r.seen.add(m.msgId);
	const me = {...geo(r.x, r.y), heading: r.kind === 'ped' ? null : HEADING};
	if (me.heading != null && isRelevant(me, m)) warn(r, m, me);
	if (shouldRelay(me, m)) {
		const ev = schedule(S.t + relayDelay(d, S.range, 0.5), () => {
			r.pending.delete(m.msgId);
			if (r.active) transmit(r, encode({...m, ttl: m.ttl - 1, hop: m.hop + 1}));
		});
		r.pending.set(m.msgId, ev);
	}
}

function warn(r, m, me) {
	if (r.alertUntil < S.t) S.stats.alerts++;
	r.alertUntil = S.t + 3;
	r.alertAt = S.t;
	r.alertAge = S.t - (S.origins.get(m.msgId) ?? S.t);
	if (r !== S.ego) return;
	const dist = Math.max(5, Math.round(track(me, m).along / 5) * 5);
	S.egoAlert = {type: m.type, dist, hop: m.hop, age: r.alertAge, at: S.t};
	if (S.voice && 'speechSynthesis' in window && (S.spoken[m.type] ?? -9) < S.t - 4) {
		S.spoken[m.type] = S.t;
		const tx = TEXT[S.lang];
		const u = new SpeechSynthesisUtterance(`${tx[m.type]}, ${dist} ${tx.m}`);
		u.lang = tx.lang;
		speechSynthesis.cancel();
		speechSynthesis.speak(u);
	}
}

function originate(n, type, extra) {
	const msgId = u32();
	S.origins.set(msgId, extra.since ?? S.t);
	transmit(n, encode({type, msgId, ttl: type === TYPE.VRU_HERE ? 1 : 3, hop: 0, sender: n.sender, ...geo(n.x, n.y), speed: n.v, heading: n.kind === 'ped' ? 0 : HEADING, ttc: null, ...extra}));
}

// ---------- motion ----------
function gapAhead(n) {
	let gap = Infinity;
	for (const o of S.nodes) {
		if (o === n || !o.active || o.x <= n.x) continue;
		if (o.kind === 'ped') {
			if (o.crossing && Math.abs(o.y - n.y) < 2.4) gap = Math.min(gap, o.x - n.x - n.len / 2 - 1);
		} else if (o.lane === n.lane) gap = Math.min(gap, o.x - o.len / 2 - (n.x + n.len / 2));
	}
	return gap;
}

function stepVehicle(n, dt) {
	const cruise = n.alertUntil > S.t ? n.vmax * 0.6 : n.vmax; // warned drivers ease off gently
	const safe = Math.max(0, (gapAhead(n) - 4) / 1.2);
	const target = n.braking ? 0 : Math.min(cruise, safe);
	const decel = n.braking ? 7.5 : safe < cruise ? 6.5 : 2;
	const v0 = n.v;
	n.v = target > n.v ? Math.min(target, n.v + 2 * dt) : Math.max(target, n.v - decel * dt);
	n.x += n.v * dt;

	// The phone's hard-brake detector, fed only by the vehicle's deceleration.
	n.hardFor = (v0 - n.v) / dt >= HARD_BRAKE ? n.hardFor + dt : 0;
	if (n.hardFor >= 0.3 && S.t - n.lastEba > 5) {
		n.lastEba = S.t;
		originate(n, TYPE.EBA, {object: KINDS[n.kind].object, severity: 3, since: n.brakeStart ?? S.t - 0.3});
	}
	if (n.braking && n.v === 0) {
		n.holdUntil ??= S.t + 2.5;
		if (S.t > n.holdUntil) Object.assign(n, {braking: false, holdUntil: null, brakeStart: null});
	}
}

// Treadmill: traffic that leaves the window comes back as a new road user on the other side.
function recycle(n) {
	if (n === S.ego) return;
	let x = null;
	if (n.x < S.view - 40) x = S.view + VIEW + rand(15, 60);
	else if (n.x > S.view + VIEW + 120) x = S.view - rand(20, 40);
	if (x == null) return;
	if (n.kind === 'ped') return Object.assign(n, {x, crossing: 0, y: PATH_Y[Math.random() < 0.5 ? 0 : 1], ...phone()});
	if (S.nodes.some((o) => o !== n && o.kind !== 'ped' && o.lane === n.lane && Math.abs(o.x - x) < 25)) return; // lane busy, retry next tick
	Object.assign(n, {x, v: n.vmax * 0.9, braking: false, holdUntil: null, brakeStart: null, hardFor: 0, ...phone()});
}

function stepPed(p, dt) {
	if (!p.crossing) return;
	p.y += p.crossing * 1.4 * dt;
	if (S.t >= p.nextBeacon) {
		p.nextBeacon = S.t + 0.5; // pocket mode beacon, 2 Hz while on the road
		originate(p, TYPE.VRU_HERE, {object: OBJECT.PEDESTRIAN, severity: 2});
	}
	const goal = PATH_Y[p.crossing > 0 ? 1 : 0];
	if ((p.crossing > 0 && p.y >= goal) || (p.crossing < 0 && p.y <= goal)) Object.assign(p, {y: goal, crossing: 0});
}

function step(dt) {
	S.t += dt;
	const due = S.events.filter((e) => e.at <= S.t).sort((a, b) => a.at - b.at);
	S.events = S.events.filter((e) => e.at > S.t);
	for (const e of due) if (!e.cancelled) e.fn();
	for (const n of S.nodes) {
		if (S.t - n.senderSince > 600) Object.assign(n, {sender: u24(), senderSince: S.t}); // privacy: rotate every 10 min
		if (n.kind === 'ped') stepPed(n, dt);
		else stepVehicle(n, dt);
		recycle(n);
	}
	S.view = S.ego.x - BEHIND;
	S.rings = S.rings.filter((r) => S.t - r.t0 < 0.8);
}

// ---------- actions ----------
export function brake(n) {
	if (!n || n.kind === 'ped' || !n.active || n.braking) return false;
	Object.assign(n, {braking: true, brakeStart: S.t});
	return true;
}

export function cross(p) {
	if (!p || p.kind !== 'ped' || p.crossing) return false;
	p.crossing = p.y < ROAD_W / 2 ? 1 : -1;
	p.nextBeacon = S.t;
	return true;
}

const pickAhead = (pred, lo, hi, ideal) =>
	S.nodes
		.filter((n) => n.active && pred(n) && n.x - S.ego.x > lo && n.x - S.ego.x < hi)
		.sort((a, b) => Math.abs(a.x - S.ego.x - ideal) - Math.abs(b.x - S.ego.x - ideal))[0];

export const brakeAhead = () => brake(pickAhead((n) => n.kind !== 'ped' && !n.braking, 90, 300, 210));
export const crossAhead = () => cross(pickAhead((n) => n.kind === 'ped' && !n.crossing, 60, 320, 170));

// ---------- drawing ----------
function draw(ctx, W, H) {
	const pad = 16;
	const sx = (W - pad * 2) / VIEW;
	const sy = Math.min(9, (H - 70) / 15);
	const px = (x) => pad + (x - S.view) * sx;
	const py = (y) => H / 2 + 8 + (ROAD_W / 2 - y) * sy;
	ctx.fillStyle = COL.bg;
	ctx.fillRect(0, 0, W, H);
	ctx.fillStyle = COL.path;
	ctx.fillRect(0, py(PATH_Y[1] + 1.6), W, 3.2 * sy);
	ctx.fillRect(0, py(PATH_Y[0] + 1.6), W, 3.2 * sy);
	ctx.fillStyle = COL.road;
	ctx.fillRect(0, py(ROAD_W), W, ROAD_W * sy);
	ctx.fillStyle = COL.line;
	ctx.fillRect(0, py(ROAD_W), W, 1);
	ctx.fillRect(0, py(0), W, 1);
	ctx.fillStyle = COL.node;
	for (let x = Math.floor(S.view / 9) * 9; x < S.view + VIEW + 9; x += 9) ctx.fillRect(px(x), py(ROAD_W / 2) - 1, 3 * sx, 2);

	const live = S.nodes.filter((n) => n.active);
	if (S.links) {
		ctx.strokeStyle = 'rgba(124,195,156,0.07)';
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let i = 0; i < live.length; i++)
			for (let j = i + 1; j < live.length; j++)
				if (Math.hypot(live[i].x - live[j].x, live[i].y - live[j].y) <= S.range) {
					ctx.moveTo(px(live[i].x), py(live[i].y));
					ctx.lineTo(px(live[j].x), py(live[j].y));
				}
		ctx.stroke();
	}

	for (const r of S.rings) {
		const a = (S.t - r.t0) / 0.8;
		const grow = Math.min(1, (S.t - r.t0) / 0.25);
		ctx.strokeStyle = `rgba(124,195,156,${(1 - a) * 0.8})`;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.arc(px(r.x), py(r.y), S.range * sx * grow, 0, Math.PI * 2);
		ctx.stroke();
	}

	ctx.font = '600 11px Bahnschrift, system-ui, sans-serif';
	ctx.textAlign = 'center';
	for (const n of live) {
		const x = px(n.x);
		const y = py(n.y);
		const warned = n.alertUntil > S.t;
		if (n.kind === 'ped') {
			ctx.fillStyle = n.crossing ? COL.text : COL.sub;
			ctx.beginPath();
			ctx.arc(x, y, 4, 0, Math.PI * 2);
			ctx.fill();
		} else {
			const w = n.len * sx;
			const h = n.wid * sy;
			ctx.fillStyle = COL.car;
			ctx.strokeStyle = n === S.ego ? COL.text : warned ? COL.acc : COL.node;
			ctx.lineWidth = n === S.ego || warned ? 2 : 1;
			ctx.beginPath();
			ctx.roundRect(x - w / 2, y - h / 2, w, h, Math.min(4, h / 3));
			ctx.fill();
			ctx.stroke();
			if (n.braking || n.hardFor > 0) {
				ctx.fillStyle = COL.brake;
				ctx.fillRect(x - w / 2 - 1, y - h / 2 + 1, 2, 3);
				ctx.fillRect(x - w / 2 - 1, y + h / 2 - 4, 2, 3);
			}
		}
		ctx.fillStyle = COL.acc;
		ctx.beginPath();
		ctx.arc(x, y, 2.2, 0, Math.PI * 2);
		ctx.fill();
		const labelY = n.kind === 'ped' ? y - 10 : y - (n.wid * sy) / 2 - 6;
		if (n === S.ego) {
			ctx.fillStyle = COL.text;
			ctx.fillText('YOU', x, labelY);
		} else if (S.t - n.alertAt < 2.5 && n.kind !== 'ped') {
			ctx.fillStyle = COL.acc;
			ctx.fillText(`+${n.alertAge.toFixed(2)} s`, x, labelY);
		}
	}

	ctx.textAlign = 'left';
	ctx.fillStyle = COL.mute;
	ctx.fillRect(pad, H - 18, 50 * sx, 2);
	ctx.fillText('50 m', pad + 50 * sx + 6, H - 13);
}

// ---------- UI ----------
const $ = (id) => document.getElementById(id);

function render() {
	const c = S.ego;
	const inRange = S.nodes.filter((n) => n !== c && n.active && Math.hypot(n.x - c.x, n.y - c.y) <= S.range).length;
	$('mesh').textContent = `${inRange} phones in Bluetooth range`;
	const a = S.egoAlert;
	const fresh = a && S.t - a.at < 4;
	$('phone').classList.toggle('alert', !!fresh);
	$('alert').textContent = fresh ? TEXT[S.lang][a.type] : 'Road clear';
	$('alert-meta').textContent = fresh ? `${a.dist} m ahead · hop ${a.hop}, ${a.age.toFixed(2)} s after it happened` : 'Listening for alerts';
	$('stats').textContent = `${S.stats.sent} packets · ${S.stats.relays} relays · ${S.stats.alerts} drivers warned`;
	$('log').innerHTML = S.log
		.map(({t, m, hex: h}) => `<div><span>${t.toFixed(2)}s ${TYPE_NAME[m.type]} hop ${m.hop} ttl ${m.ttl} #${m.sender.toString(16).padStart(6, '0').toUpperCase()}</span><code>${h}</code></div>`)
		.join('');
}

export function start() {
	populate();
	const canvas = $('road');
	const ctx = canvas.getContext('2d');
	const resize = () => {
		const dpr = window.devicePixelRatio || 1;
		canvas.width = canvas.clientWidth * dpr;
		canvas.height = canvas.clientHeight * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	};
	addEventListener('resize', resize);
	resize();

	canvas.addEventListener('click', (e) => {
		const rect = canvas.getBoundingClientRect();
		const W = canvas.clientWidth;
		const sx = (W - 32) / VIEW;
		const x = S.view + (e.clientX - rect.left - 16) / sx;
		const hit = S.nodes.filter((n) => n.active && Math.abs(n.x - x) < Math.max(4, (n.len ?? 2) / 2 + 2)).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x));
		const sy = Math.min(9, (canvas.clientHeight - 70) / 15);
		const y = ROAD_W / 2 - (e.clientY - rect.top - canvas.clientHeight / 2 - 8) / sy;
		const n = hit.sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y))[0];
		if (n?.kind === 'ped') cross(n);
		else brake(n);
	});
	$('brake').onclick = () => brakeAhead() || flash('Nothing far enough ahead yet, try again in a second.');
	$('cross').onclick = () => crossAhead() || flash('No pedestrian ahead of you right now, try again in a second.');
	$('slow').onclick = (e) => {
		S.rate = S.rate === 1 ? 0.25 : 1;
		e.target.textContent = S.rate === 1 ? 'Slow motion' : 'Normal speed';
	};
	$('lang').onchange = (e) => (S.lang = e.target.value);
	$('voice').onchange = (e) => (S.voice = e.target.checked);
	$('links').onchange = (e) => (S.links = e.target.checked);
	$('range').oninput = (e) => {
		S.range = +e.target.value;
		$('range-v').textContent = `${S.range} m`;
	};

	let last = performance.now();
	const frame = (now) => {
		let dt = Math.min(0.05, (now - last) / 1000) * S.rate;
		last = now;
		while (dt > 0) {
			step(Math.min(0.02, dt));
			dt -= 0.02;
		}
		draw(ctx, canvas.clientWidth, canvas.clientHeight);
		render();
		requestAnimationFrame(frame);
	};
	requestAnimationFrame(frame);
}

function flash(msg) {
	$('hint').textContent = msg;
	setTimeout(() => ($('hint').textContent = 'Click any vehicle to slam its brakes. Click a pedestrian to send them across the road.'), 2500);
}
