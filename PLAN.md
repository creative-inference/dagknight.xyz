# DAG Gate — On-Chain BBS Game via TN12

## Goal
Run The DAG Gate as a **static frontend + TN12 node** with no backend server. The browser connects directly to a Kaspa TN12 node via wRPC WebSocket. Game state lives on-chain as covenant-enforced UTXOs. The BlockDAG is the server.

## Architecture

```
GitHub Pages (static)          TN12 Node
┌──────────────┐         ┌──────────────────┐
│  HTML/CSS/JS │         │  wRPC JSON :18310 │
│  kaspa-wasm  │◄──WSS──►│  Covenant engine  │
│  (tx build)  │         │  ZK verification  │
└──────────────┘         └──────────────────┘
      │                         │
      │   No backend server     │
      │   No database           │
      └─────────────────────────┘
```

Browser reads UTXOs, builds covenant txs via kaspa-wasm, signs locally, submits via wRPC. That's the entire stack.

## Current State (Phase 0 — Done)
- [x] Playable client-side demo with BBS terminal aesthetic
- [x] Full game loop: character creation, forest combat, shop, inn, PvP
- [x] Simulated chain activity log showing covenant tx equivalents
- [x] Game intro explaining covenant architecture mapping
- [x] localStorage persistence
- [x] Game nav link in site navigation

## Phase 1: Connect to Live TN12 (read-only)

Replace the simulated chain log with real BlockDAG data.

### 1.1 wRPC WebSocket Client
- Update `chain.js` to connect to TN12 wRPC JSON endpoint (`wss://<node>:18310`)
- Subscribe to new block notifications (real 10 BPS feed)
- Display: block hash, DAA score, tx count, parent count
- Reconnect with backoff; show connection status in chain panel
- Node URL in `_config.yml` as `tn12_wrpc_url` (falls back to simulated if empty)

### 1.2 Read Chain State
- Query `GetBlockDagInfo` for network stats (DAA score, tip count, difficulty)
- Query `GetUtxosByAddresses` to show real UTXO data
- Display live network stats in chain panel header

### 1.3 Prerequisites
- [ ] TN12 node running with wRPC JSON enabled
- [ ] Node accessible via `wss://` (reverse proxy with TLS for browser security)
- [ ] Determine: run our own node or use community endpoint

## Phase 2: On-Chain Game State

Game state moves from localStorage to covenant UTXOs. Browser builds and submits real transactions.

### 2.1 Browser Transaction Construction — PROVEN (2026-03-25)

**All components work in the browser:**
- `@kasdk/web` (v0.15.2) — browser-compatible WASM build of the Kaspa SDK
- `PrivateKey` — generate random keypair, derive TN12 address
- `ScriptBuilder` — construct custom scripts with arbitrary opcodes
- `ScriptPublicKey` — wrap scripts into transaction outputs
- `Transaction` — assemble complete transactions with custom script outputs
- `POST https://api-tn12.kaspa.org/transactions` — submit to TN12 (REST API)
- `GET https://api-tn12.kaspa.org/addresses/{addr}/utxos` — read UTXOs

**Architecture confirmed:**
```
SilverScript compiler → script hex → ScriptBuilder.fromScript() → Transaction → POST to TN12 REST API
```

**Key findings:**
- TN12 is NOT in the public wRPC Resolver — use REST API at `api-tn12.kaspa.org` instead
- No wRPC WebSocket needed for Phase 2 — REST API has full tx submission
- Keypair generated in browser, stored in localStorage
- Fund via faucet (when available) or CPU mining

### 2.2 SilverScript Covenants

```
contracts/
  player.ss    — Character state (self-preserving UTXO)
  game.ss      — Episodic combat (created on encounter, consumed on resolution)
  shop.ss      — Persistent shop inventory
  arena.ss     — PvP with staked KAS + timeout
```

**Player covenant** (`player.ss`)
- State: name, class, level, xp, hp, attack, defense, gold, weapon, armor
- Self-preserving: every spend must recreate the UTXO with updated state
- Auth-bound to player's pubkey
- Spends: `combat_update`, `shop_purchase`, `inn_rest`, `pvp_result`

**Game covenant** (`game.ss`)
- Episodic: created when entering forest, consumed when combat resolves
- ICC with Player covenant in single atomic tx
- Monster selection deterministic from block hash (verifiable randomness)

**Shop covenant** (`shop.ss`)
- Persistent shared state (inventory, prices)
- ICC with Player: atomic tx validates gold transfer + item grant

**Arena covenant** (`arena.ss`)
- Two Player covenant inputs + Arena covenant input
- Timeout via `this.age > 300` (5 min per turn)
- Winner gets staked KAS

### 2.3 ZK Proof Generation
- RISC Zero guest program for combat math validation
  - Input: player stats, monster stats, random seed (block hash)
  - Output: valid state transition (new HP, XP, gold)
  - Proof submitted alongside covenant spend
- Alternative: inline SilverScript for simpler combat math (avoid proof overhead)

### 2.4 Hybrid Fallback
- If node disconnects, game continues client-side with localStorage
- Reconnect syncs local state back to chain when possible
- UI state (animations, text rendering) always client-side

## Phase 3: Multiplayer

### 3.1 Shared World
- Player UTXOs visible to all — leaderboard by scanning covenant UTXOs
- PvP challenges: construct Arena covenant tx referencing opponent's Player UTXO
- Opponent notified via UTXO subscription

### 3.2 Protocol-Native Mechanics
- Daily fight reset: `require(this.age > 86400)` on Player UTXO — no server clock
- Gold = locked test KAS (sompi) in Player covenant
- PvP stakes: both players lock KAS, winner takes pot
- Inn cost: KAS fee for HP restore

## File Structure

```
game/
  index.html              — game page with terminal + chain panel
assets/
  css/
    game.css              — terminal + chain panel styles
  js/
    game/
      engine.js           — screen manager, renderer, input
      screens.js          — all game screens
      combat.js           — combat math
      data.js             — monsters, items, levels, ASCII art
      state.js            — localStorage (Phase 0-1) / UTXO state (Phase 2)
      chain.js            — wRPC WebSocket client + chain panel
contracts/                — SilverScript source (Phase 2)
  player.ss
  game.ss
  shop.ss
  arena.ss
proofs/                   — RISC Zero guest programs (Phase 2)
  combat/
    src/main.rs
```

## Open Questions
- [x] ~~Does kaspa-wasm support covenant script construction in browser?~~ YES — `@kasdk/web` v0.15.2, `ScriptBuilder` + `Transaction` confirmed working (2026-03-25)
- [x] ~~TN12 node hosting~~ — REST API at `api-tn12.kaspa.org` is public, includes tx submission
- [ ] Faucet — need test KAS for Phase 2 (CPU mine or request from team?)
- [ ] SilverScript stability — compiler API may change before mainnet (Covenants++ HF date TBD)
- [ ] Verifiable randomness — block hash as monster seed fair enough for demo?
- [ ] Browser wallet extensions — will KasWare add covenant tx support?
- [ ] SilverScript → script hex — can we compile in browser (WASM compiler) or pre-compile and embed?
