# DAG Gate — TN12 Chain Integration Plan

## Goal
Add a live TN12 chain activity panel alongside the game terminal, showing real BlockDAG activity at 10 BPS while the player plays. Game actions flash "simulated covenant tx" overlays to demonstrate what on-chain gameplay will look like.

## Prerequisites
- [ ] TN12 node running with wRPC JSON enabled (port 18310)
- [ ] Node publicly accessible (or tunneled) so browser WebSocket can connect
- [ ] Test KAS in a wallet for future Phase 2 tx submission

## Phase 1: Live Chain Panel (read-only, no game txs)

### 1.1 Chain Activity WebSocket Client
- New file: `assets/js/game/chain.js`
- Connect to TN12 wRPC JSON endpoint via WebSocket (`wss://<node>:18310`)
- Subscribe to new block notifications
- Parse: block hash, DAA score, tx count, timestamp, number of parents (merge set)
- Reconnect logic with backoff
- Config: node URL stored in `_config.yml` as `tn12_wrpc_url` (empty = panel hidden)

### 1.2 Chain Panel UI
- New sidebar or bottom strip alongside the terminal
- Styled as a second "monitor" — different border color (cyan vs green)
- Shows:
  - **DAA Score** — ticking counter (like an odometer)
  - **BPS** — calculated from recent blocks
  - **Block Feed** — scrolling list of recent blocks (hash prefix, tx count, parents)
  - **Network Stats** — total blocks, tips count, header count
- Auto-scrolls, max ~20 visible blocks, old ones fade out
- ASCII-styled to match BBS aesthetic

### 1.3 Layout Changes
- `game/index.html`: wrap terminal + chain panel in a flex container
- Desktop: terminal (left, 60%) + chain panel (right, 40%)
- Mobile: chain panel collapses to a thin ticker bar above terminal
- `game.css`: new `.chain-panel` styles

### 1.4 Game Action Flashes
- When player performs an action (attack, buy, rest, PvP), emit an event
- Chain panel shows a highlighted "simulated tx" entry:
  ```
  ► COVENANT TX (simulated)
    Player::attack → Game::combat
    State: HP 45→38, Gold +40
  ```
- Styled differently from real blocks (gold border, pulsing glow)
- Maps each game action to its covenant equivalent:
  - Attack → `Game covenant spend (episodic)`
  - Buy item → `ICC: Player + Shop atomic tx`
  - Rest at inn → `Player covenant 1:1 transition`
  - PvP → `Player + Player + Arena atomic tx`
  - Level up → `Player covenant state update`

## Phase 2: On-Chain Game State (requires stable SilverScript)

### 2.1 Covenant Contracts
- `contracts/player.ss` — Player state covenant (SilverScript)
  - State: name, class, level, xp, hp, attack, defense, gold, weapon, armor
  - Spends: combat_update, shop_purchase, inn_rest, pvp_result
  - Self-preserving: output must carry same covenant with updated state
  - Auth-bound to player pubkey

- `contracts/game.ss` — Episodic combat covenant
  - Created on forest entry, consumed on combat resolution
  - ICC with Player covenant: atomic tx validates combat math
  - Monster selection deterministic from block hash (verifiable randomness)

- `contracts/shop.ss` — Persistent shop covenant
  - Holds inventory state
  - ICC with Player: validates gold transfer + item grant

- `contracts/arena.ss` — PvP covenant
  - Two player inputs + arena input
  - Timeout via `this.age > 300` (5 min per turn)
  - Winner gets staked KAS

### 2.2 Proof Generation
- RISC Zero guest program for combat validation
  - Input: player stats, monster stats, random seed (from block hash)
  - Output: valid state transition (new HP, XP, gold)
  - Proof submitted alongside covenant spend
- Alternatively: inline SilverScript validation for simpler combat math

### 2.3 Transaction Construction (Browser)
- Use `kaspa-wasm` SDK (Rust→WASM) for tx building in browser
- Sign with browser-held keypair (or wallet extension when available)
- Submit via wRPC `SubmitTransaction`
- Game state read from UTXOs via `GetUtxosByAddresses`

### 2.4 Hybrid State
- On-chain: character state, gold balance, PvP stakes (real test KAS)
- Client-side: UI state, animation, sound, text rendering
- Fallback: if node disconnected, game continues client-side with localStorage

## Phase 3: Multiplayer

### 3.1 Shared World
- Player UTXOs visible to all — leaderboard by scanning covenant UTXOs
- PvP challenges: construct Arena covenant tx referencing opponent's Player UTXO
- Opponent sees pending tx via UTXO notification subscription

### 3.2 Daily Reset Mechanism
- `this.age` introspection on Player UTXO
- Forest fight counter resets when UTXO age > 86400 seconds
- No server needed — time enforcement is protocol-native

### 3.3 Economy
- Gold = locked test KAS (sompi) in Player covenant
- Shop prices in real sompi
- PvP stakes: both players lock KAS, winner takes pot
- Inn cost burns KAS (sent to unspendable address or fee)

## File Structure (Final)

```
game/
  index.html              — game page with terminal + chain panel
  architecture/
    index.html            — detailed covenant architecture explainer
assets/
  css/
    game.css              — terminal + chain panel styles
  js/
    game/
      engine.js           — screen manager, renderer, input
      screens.js          — all game screens
      combat.js           — combat math
      data.js             — monsters, items, levels, ASCII art
      state.js            — localStorage state (Phase 1) / UTXO state (Phase 2)
      chain.js            — TN12 WebSocket client + chain panel renderer
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
- [ ] Public TN12 node endpoint — run our own or wait for community infra?
- [ ] Faucet — need test KAS for Phase 2. CPU mine or request from team?
- [ ] SilverScript stability — compiler API may change before mainnet (May 5, 2026)
- [ ] Wallet integration — browser extension vs embedded keypair?
- [ ] Verifiable randomness — use block hash as seed for monster selection? Fair enough for demo?
