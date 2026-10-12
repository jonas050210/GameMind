# Litematica bridge protocol (plan-only v1)

This document specifies the receiver currently implemented in GameMind. It does **not** claim that a Fabric/Litematica client sender exists, and it does not enable block placement. Exact Minecraft 1.20.4, Fabric, Litematica, and MaLiLib versions for the user's Modrinth profile have not been supplied, so no client-mod API has been pinned or compiled.

## Safety boundary

The receiver can accept a signed report about an active placement, display its world, dimension, origin, rotation, mirror, bounds, and fingerprint, and record an in-memory operator review. It has **no route or code path for Minecraft actions**. An operator's terminal `confirm <fingerprint>` means “I reviewed this exact placement,” not “build it.” There is no construction executor in this workflow.

A report is accepted only when it is authenticated, fresh (at most five seconds old), in sequence, for the exact imported file SHA-256, and consistent with the blueprint dimensions. Protocol v1 requires every imported region to be enabled. A moved/rotated/mirrored placement, changed world/dimension, changed region set, changed file, client restart, bad signature, replay, or missed heartbeat clears review approval. A fresh unchanged heartbeat refreshes the short lease without requiring repeated approval.

The receiver binds to `127.0.0.1:39990` by default. HMAC authenticates messages but does not encrypt them. Do not bind it to a public interface. Non-loopback binding requires both `--allow-nonloopback-litematic-bridge` and an explicit host; use it only on a trusted private network with a firewall rule.

## Offline blueprint import

```bash
npm ci
npm run dev -- --litematic-plan "/path/to/house.litematic"
npm run dev -- --litematic-plan "/path/to/house.litematic" --litematic-layer 0
```

This reads a Java Edition `.litematic` file and prints its name, author, dimensions, regions, non-air block count, block totals, and SHA-256. The optional `--litematic-layer Y` renders one normalized Y layer as an ASCII top-down map (`.` is air); it does not compare against a world. It does not connect to Minecraft. Imports are bounded to 64 MiB compressed/source bytes, 128 MiB decompressed NBT, 32 regions, 256 blocks per combined axis, 1,000,000 bounding-box cells, and 100,000 non-air blocks. Entities and block-entity NBT (for example, chest contents) are not imported. Conflicting non-air blocks in overlapping regions are rejected.

The importer uses the `.litematic` NBT palette and packed block-state data. Its coordinates are normalized to the minimum corner of all regions. The active-placement protocol treats `origin` as the inclusive world-space minimum corner after rotation/mirroring; the sender must use that exact convention.

## Start the authenticated receiver

Create a high-entropy shared secret in WSL and keep it out of source control and logs:

```bash
export GAMEMIND_LITEMATICA_BRIDGE_TOKEN="$(openssl rand -hex 32)"
python3 main.py -- --litematic-bridge "/path/to/house.litematic"
```

The receiver prints a one-time review fingerprint when placement identity changes. In an interactive terminal:

```text
status
confirm <full-64-character-review-fingerprint>
cancel
help
```

`confirm` records only a review of that exact live placement. A bridge heartbeat is required every five seconds or less; after the lease expires, approval is cleared. `cancel` clears local review state but does not move, disable, or change the Litematica placement.

Configuration:

- `GAMEMIND_LITEMATICA_BRIDGE_TOKEN`: required; at least 32 UTF-8 bytes. Share it with the client sender out of band.
- `GAMEMIND_LITEMATICA_BRIDGE_HOST`: default `127.0.0.1`.
- `GAMEMIND_LITEMATICA_BRIDGE_PORT`: default `39990`; `0` selects a free port.
- CLI flags `--litematic-bridge-host`, `--litematic-bridge-port` override the corresponding host and port. `--allow-nonloopback-litematic-bridge` is required for a non-loopback host.

For Windows Modrinth clients and WSL2, try WSL's localhost forwarding first. Do not open a broad Windows Firewall rule or expose this port to the Internet. If localhost forwarding is unavailable, configure a private, firewalled address explicitly and keep the HMAC token secret.

## HTTP contract

The server exposes only:

```http
POST /v1/placement
Content-Type: application/json
X-GameMind-Signature: <lowercase-or-uppercase-hex HMAC-SHA256>
```

The HMAC is computed over the **exact UTF-8 request bytes** with the shared token as the HMAC key. The request body limit is 16 KiB. There is no CORS permission, no browser route, no approval endpoint, no schematic upload route, and no action endpoint.

Example body (coordinates and identifiers are illustrative):

```json
{
  "protocolVersion": 1,
  "clientInstanceId": "fabric-startup-random-id",
  "sequence": 1042,
  "sentAtMs": 1791781200000,
  "placementId": "active-placement-uuid",
  "blueprintSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "worldId": "stable-world-or-server-fingerprint",
  "dimension": "minecraft:overworld",
  "origin": { "x": 120, "y": 64, "z": -30 },
  "rotation": 90,
  "mirror": "none",
  "enabledRegions": ["main"],
  "bounds": {
    "min": { "x": 120, "y": 64, "z": -30 },
    "max": { "x": 136, "y": 74, "z": -12 }
  }
}
```

Contract requirements:

- `clientInstanceId` is regenerated on client startup; `sequence` increases for each report in that instance.
- `sentAtMs` is Unix epoch milliseconds. Keep the Windows/WSL clocks synchronized.
- `blueprintSha256` is SHA-256 over the exact `.litematic` bytes GameMind imported.
- `worldId` must identify the saved world/server consistently; a display name alone is not sufficient. `dimension` is a namespaced dimension ID.
- `origin` equals `bounds.min`; bounds are inclusive. Their dimensions must equal the normalized blueprint dimensions after the reported quarter-turn rotation.
- `rotation` is one of `0`, `90`, `180`, `270`; `mirror` is `none`, `left_right`, or `front_back`.
- `enabledRegions` must exactly match all region names in the imported blueprint. Partial-region placements are deliberately rejected in v1.
- A client should send a heartbeat about once per second, and immediately send a new report after any identity/transform/bounds change.

## Not yet implemented

There is no Fabric client sender, no stable Litematica active-placement API integration, no in-game placement-to-world diff, and no Litematica block-placement executor. The receiver is a versioned, authenticated boundary for future work only. The user's exact Modrinth/Fabric/Litematica/MaLiLib versions and client/WSL network mode are still unknown; do not treat this protocol as a tested mod integration. Do not connect it to a live world or build from it without separate approval.
