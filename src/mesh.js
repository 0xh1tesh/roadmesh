// Mesh rules every phone runs on a received alert: is it for me, and should I pass it on?
import {TYPE} from './packet.js';

const R_EARTH = 6371000;
export const M_PER_DEG = (R_EARTH * Math.PI) / 180;
const rad = (d) => (d * Math.PI) / 180;

// Metres east (x) and north (y) from a to b. Equirectangular, fine over a few km.
export function offset(a, b) {
	return {
		x: rad(b.lon - a.lon) * Math.cos(rad((a.lat + b.lat) / 2)) * R_EARTH,
		y: rad(b.lat - a.lat) * R_EARTH,
	};
}

export const distance = (a, b) => {
	const {x, y} = offset(a, b);
	return Math.hypot(x, y);
};

// Position of b relative to a's heading: along > 0 means ahead, cross > 0 means to the right.
export function track(me, b) {
	const {x, y} = offset(me, b);
	const h = rad(me.heading);
	return {along: x * Math.sin(h) + y * Math.cos(h), cross: x * Math.cos(h) - y * Math.sin(h)};
}

const headingDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

// Warn only for hazards ahead, roughly in my path, close, and (for vehicles) going my way.
export function isRelevant(me, alert, {maxAhead = 400, maxBearing = 30, maxHeadingDiff = 45} = {}) {
	const {along, cross} = track(me, alert);
	if (along <= 0 || along > maxAhead) return false;
	if ((Math.abs(Math.atan2(cross, along)) * 180) / Math.PI > maxBearing) return false;
	if (alert.type !== TYPE.VRU_HERE && headingDiff(me.heading, alert.heading) > maxHeadingDiff) return false;
	return true;
}

// Relay while hops remain, near the hazard, and only if it is not well behind me.
// Phones without a heading (pedestrians) relay anything nearby.
export function shouldRelay(me, alert, {maxDistance = 500, behindSlack = 20} = {}) {
	if (alert.ttl <= 0 || distance(me, alert) > maxDistance) return false;
	return me.heading == null || track(me, alert).along > -behindSlack;
}

// Contention delay in seconds: the farthest receiver relays first, nearer ones
// hear that relay during their wait and stay quiet (classic VANET broadcast suppression).
export const relayDelay = (d, range, tMax = 0.2) => tMax * (1 - Math.min(d, range) / range);
