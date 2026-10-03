import assert from 'node:assert/strict';
import test from 'node:test';
import {M_PER_DEG, isRelevant, relayDelay, shouldRelay} from '../src/mesh.js';
import {OBJECT, SIZE, TYPE, decode, encode} from '../src/packet.js';

const base = {lat: 12.9172, lon: 77.6227};
// Point `m` metres east of base (vehicles below drive east, heading 90).
const east = (m, y = 0) => ({lat: base.lat + y / M_PER_DEG, lon: base.lon + m / (M_PER_DEG * Math.cos((base.lat * Math.PI) / 180))});

const alert = {type: TYPE.EBA, msgId: 0x8f2cd407, ttl: 3, hop: 0, sender: 0xa65e19, ...east(150), speed: 12.4, heading: 90, object: OBJECT.BUS, ttc: 1.8, severity: 3};

test('packet is 24 bytes and round-trips', () => {
	const b = encode(alert);
	assert.equal(b.length, SIZE);
	const m = decode(b);
	for (const k of ['type', 'msgId', 'ttl', 'hop', 'sender', 'object', 'severity']) assert.equal(m[k], alert[k], k);
	assert.ok(Math.abs(m.lat - alert.lat) < 1e-7 && Math.abs(m.lon - alert.lon) < 1e-7);
	assert.equal(m.speed, 12.4);
	assert.equal(m.ttc, 1.8);
	assert.ok(Math.abs(m.heading - 90) <= 360 / 256);
});

test('ttl and hop share one byte without bleeding', () => {
	const m = decode(encode({...alert, ttl: 7, hop: 5, flags: 3}));
	assert.deepEqual([m.ttl, m.hop, m.flags], [7, 5, 3]);
});

test('missing ttc encodes as none, bad input is rejected', () => {
	assert.equal(decode(encode({...alert, ttc: null})).ttc, null);
	assert.throws(() => decode(new Uint8Array(23)));
	const b = encode(alert);
	b[0] = 0x21;
	assert.throws(() => decode(b), /version/);
});

test('relevance: ahead, same way, close', () => {
	const me = {...east(0), heading: 90};
	assert.equal(isRelevant(me, alert), true);
	assert.equal(isRelevant(me, {...alert, ...east(-50)}), false, 'behind');
	assert.equal(isRelevant(me, {...alert, ...east(450)}), false, 'too far');
	assert.equal(isRelevant(me, {...alert, heading: 270}), false, 'oncoming traffic');
	assert.equal(isRelevant(me, {...alert, ...east(40, 60)}), false, 'off to the side');
	assert.equal(isRelevant(me, {...alert, type: TYPE.VRU_HERE, heading: 0}), true, 'pedestrians ignore heading');
});

test('relay: hops left, near the hazard, not behind', () => {
	const me = {...east(0), heading: 90};
	assert.equal(shouldRelay(me, alert), true);
	assert.equal(shouldRelay(me, {...alert, ttl: 0}), false);
	assert.equal(shouldRelay(me, {...alert, ...east(600)}), false);
	assert.equal(shouldRelay({...east(200), heading: 90}, alert), false, 'hazard 50 m behind');
	assert.equal(shouldRelay({...east(200), heading: null}, alert), true, 'pedestrian phone');
});

test('farthest receiver relays first', () => {
	assert.ok(relayDelay(80, 90) < relayDelay(20, 90));
	assert.equal(relayDelay(90, 90), 0);
	assert.equal(relayDelay(200, 90), 0);
});
