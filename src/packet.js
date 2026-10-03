// The 24-byte RoadMesh alert. Small enough for a legacy 31-byte BLE advert.
//
// byte  field
// 0     version (4 bits) | type (4 bits)
// 1-4   message id (uint32), used to drop duplicates
// 5     ttl (3 bits) | hop (3 bits) | flags (2 bits)
// 6-8   sender id (uint24), rotates every 10 minutes
// 9-12  latitude (int32, 1e-7 deg)
// 13-16 longitude (int32, 1e-7 deg)
// 17-18 speed (uint16, 0.1 m/s)
// 19    heading (uint8, 360/256 deg steps, clockwise from north)
// 20    object class
// 21    time to collision (uint8, 0.1 s, 255 = none)
// 22    severity (0-3)
// 23    reserved

export const SIZE = 24;
export const VERSION = 1;
export const TYPE = {EBA: 1, FCW: 2, OBJECT_AHEAD: 3, CRASH: 4, POTHOLE: 5, VRU_HERE: 6};
export const TYPE_NAME = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));
export const OBJECT = {NONE: 0, CAR: 1, TWO_WHEELER: 2, BUS: 3, PEDESTRIAN: 4};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function encode(m) {
	const b = new Uint8Array(SIZE);
	const v = new DataView(b.buffer);
	v.setUint8(0, (VERSION << 4) | (m.type & 0xf));
	v.setUint32(1, m.msgId >>> 0);
	v.setUint8(5, ((m.ttl & 7) << 5) | ((m.hop & 7) << 2) | ((m.flags ?? 0) & 3));
	v.setUint8(6, (m.sender >>> 16) & 0xff);
	v.setUint16(7, m.sender & 0xffff);
	v.setInt32(9, Math.round(m.lat * 1e7));
	v.setInt32(13, Math.round(m.lon * 1e7));
	v.setUint16(17, clamp(Math.round((m.speed ?? 0) * 10), 0, 0xffff));
	v.setUint8(19, Math.round(((((m.heading ?? 0) % 360) + 360) % 360) * (256 / 360)) & 0xff);
	v.setUint8(20, m.object ?? OBJECT.NONE);
	v.setUint8(21, m.ttc == null ? 255 : clamp(Math.round(m.ttc * 10), 0, 254));
	v.setUint8(22, clamp(m.severity ?? 0, 0, 3));
	return b;
}

export function decode(b) {
	if (b.length !== SIZE) throw new Error(`expected ${SIZE} bytes, got ${b.length}`);
	const v = new DataView(b.buffer, b.byteOffset, SIZE);
	const version = v.getUint8(0) >> 4;
	if (version !== VERSION) throw new Error(`unknown version ${version}`);
	const ttc = v.getUint8(21);
	return {
		type: v.getUint8(0) & 0xf,
		msgId: v.getUint32(1),
		ttl: v.getUint8(5) >> 5,
		hop: (v.getUint8(5) >> 2) & 7,
		flags: v.getUint8(5) & 3,
		sender: (v.getUint8(6) << 16) | v.getUint16(7),
		lat: v.getInt32(9) / 1e7,
		lon: v.getInt32(13) / 1e7,
		speed: v.getUint16(17) / 10,
		heading: (v.getUint8(19) * 360) / 256,
		object: v.getUint8(20),
		ttc: ttc === 255 ? null : ttc / 10,
		severity: v.getUint8(22),
	};
}

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
