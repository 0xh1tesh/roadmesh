# RoadMesh

Zero-hardware V2X. Every phone on the road, in a car, on a bike or in a pedestrian's pocket, becomes a safety node. Phones detect hazards, share them phone to phone over Bluetooth with no internet, and speak the warning before the driver can see the danger.

Team JSONs, iQOO Hackathon 2026, Mobility track.

## What this prototype shows

A browser simulator of a busy road where every road user carries a phone. The phones only talk through simulated Bluetooth broadcasts, and they use the same protocol code the Android app will run.

- **Hard-brake detection.** Click a car and it brakes. Its phone sees deceleration above 0.45 g held for 300 ms and broadcasts an Emergency Brake Alert.
- **Multi-hop relay.** The alert hops up to 3 times. The farthest receiver relays first, and nearer phones that hear the relay stay quiet, which avoids a broadcast storm.
- **Relevance filter.** A phone warns its driver only if the hazard is ahead, in the same direction, and under 400 m away. Warned drivers ease off.
- **Pocket mode.** Click a pedestrian and they cross. Their phone beacons "I am here" twice a second, and cars approaching them get a warning.
- **Spoken alerts.** Your car speaks the warning in English, Hindi or Kannada (through the browser's speech engine).
- **Real packets.** Every packet in the log is the actual 24-byte format, shown in hex.

## Run it

No dependencies. Serve the folder over HTTP, because ES modules do not load from `file://`:

```bash
npx serve .
```

or `python -m http.server`, then open the printed address. Use "Slow motion" to watch individual hops.

```bash
npm test
```

runs the protocol tests (Node 18+, built-in test runner).

## The 24-byte alert

| Bytes | Field | Notes |
|---|---|---|
| 0 | version, type | 4 bits each. EBA, FCW, object ahead, crash, pothole, pedestrian |
| 1-4 | message id | drops duplicates |
| 5 | ttl, hop, flags | 3 + 3 + 2 bits |
| 6-8 | sender id | rotates every 10 minutes for privacy |
| 9-16 | latitude, longitude | int32 at 1e-7 degrees |
| 17-19 | speed, heading | 0.1 m/s, 360/256 degree steps |
| 20-23 | object, time to collision, severity, reserved | |

It fits a legacy 31-byte BLE advert, so older phones can join. When extended advertising is available, a 64-byte Ed25519 signature can be appended.

## Code

| File | What it does |
|---|---|
| `src/packet.js` | Encode and decode the 24-byte alert |
| `src/mesh.js` | Relevance filter, relay rule, contention delay |
| `src/sim.js` | Road simulation, simulated radio, drawing, UI |
| `test/protocol.test.js` | Tests for the packet and mesh rules |

`packet.js` and `mesh.js` are pure functions with no browser APIs, written to port line for line to Kotlin.

## Next: the Android app

- BLE extended advertising (`AdvertisingSet`) plus a continuous low-latency scan, in a foreground service
- IMU in the vehicle frame for hard-brake and crash detection
- CameraX with YOLO26n on the Snapdragon NPU for vehicles, pedestrians and potholes, and time to collision from bounding-box growth
- Templated TTS for alerts (no AI on the safety path), with a local LLM for explanations and SOS reports
- A laptop dashboard mirrored through vivo Office Kit
