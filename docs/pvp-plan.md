# Real PvP — Multi-Round Turn-Based Combat

## Overview

Two players' covenant UTXOs are updated atomically in one transaction after
a multi-round combat session. Combat rounds happen on the server (deterministic
seeded RNG). Only the final state change goes on-chain via an ICC tx with
dual Schnorr signatures.

## Architecture

```
Player A (browser)          Server (Node.js)          Player B (browser)
      |                         |                           |
      |-- POST /challenge ----->|                           |
      |                         |-- challenge appears ----->|
      |                         |                           |
      |                         |<-- POST /accept ---------|
      |                         |   (creates session)       |
      |                         |                           |
      |<-- pvp/status -------->|<-------- pvp/status ------>|
      |   (poll every 5s)       |     (poll every 5s)       |
      |                         |                           |
  [A's turn]                    |                           |
      |-- POST /pvp/action ---->|                           |
      |   {attack/defend/heal}  |-- damage calculated ----->|
      |                         |   (seeded RNG)            |
      |                         |                           |
      |                     [B's turn]                      |
      |                         |<-- POST /pvp/action ------|
      |<-- damage result -------|   {attack/defend/heal}    |
      |                         |                           |
      |   ... rounds continue until HP <= 0 or forfeit ... |
      |                         |                           |
  [Combat ends]                 |                           |
      |-- POST /pvp/sign ------>|                           |
      |   (A's sig_script)      |<-- POST /pvp/sign -------|
      |                         |   (B's sig_script)        |
      |                         |                           |
      |<-- both sigs ready -----|                           |
      |                         |                           |
      |-- build & submit ICC tx |                           |
      |-- POST /pvp/complete -->|                           |
      |   (txId)                |-- "settled on-chain" ---->|
```

## Server State

### Combat Session (`/root/pvp.json`)

```json
{
  "session_id": {
    "id": "mnet123abc",
    "status": "active|finished|completed",
    "turn": "a|b",
    "round": 5,
    "seed": "mnet123abc",
    "a": {
      "name": "Sir Galahad",
      "addr": "kaspatest:q...",
      "pubkey": "abc123...",
      "hp": 18,
      "maxHp": 25,
      "gold": 42,
      "level": 2,
      "attack": 9,
      "defense": 5,
      "utxo": { "outpoint": {...}, "amount": "19980000" },
      "sigScript": null
    },
    "b": { ... same structure ... },
    "log": [
      { "round": 1, "action": "attack", "who": "Sir Galahad", "target": "DarkMage", "dmg": 5, "theirHp": 20 },
      { "round": 2, "action": "heal", "who": "DarkMage", "heal": 5, "myHp": 25 }
    ],
    "lastActionTs": 1711871234567,
    "winner": null,
    "reason": null
  }
}
```

## API Endpoints

### Challenge Flow

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/challenge` | POST | `{fromAddr, toAddr, fromName, toName, fromPubkey, fromHp, fromGold, fromLevel, fromUtxo}` | `{ok, challengeId}` |
| `/challenges?addr=X` | GET | — | `[{id, fromName, toName, status, ...}]` |
| `/accept` | POST | `{challengeId, toAddr, toPubkey, toHp, toGold, toLevel, toUtxo, toName}` | `{ok, sessionId}` |

### Combat Flow

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/pvp/status?addr=X` | GET | — | `{id, status, turn, round, a, b, log, lastActionTs}` or `null` |
| `/pvp/action` | POST | `{sessionId, addr, action}` | `{ok, status, round}` or `{ok, status: "finished", winner}` |

Actions: `"attack"`, `"defend"`, `"heal"`, `"forfeit"`

### Settlement Flow

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/pvp/sign` | POST | `{sessionId, addr, sigScript}` | `{ok, ready, a, b}` |
| `/pvp/complete` | POST | `{sessionId, txId}` | `{ok}` |

## Combat Mechanics

### Damage Calculation
- Seeded RNG: `seed = sessionId + "_r" + round + "_" + playerAddr`
- Deterministic — same seed always produces same result
- `damage = max(1, rng(attacker.attack) + 1 - rng(defender.defense + 1))`

### Actions
- **Attack**: full damage to opponent
- **Defend**: half attack power counter + permanent +2 defense for this fight
- **Heal**: restore 20% of max HP
- **Forfeit**: lose half your gold to opponent, combat ends

### Win Condition
- Opponent HP reaches 0 → winner takes half of loser's gold
- Opponent forfeits → winner takes half of forfeiter's gold
- Timeout (1 hour inactivity) → treated as forfeit

### Stats
- `attack = 5 + level * 2` (base from level, no weapon bonus in PvP)
- `defense = 3 + level` (base from level, no armor bonus in PvP)
- HP = current on-chain HP at time of challenge

## Client-Side UI

### PvP Status Polling
- Poll `/api/pvp/status?addr=X` every 5 seconds
- If active session found, show combat UI in the chat panel or a modal

### Combat Display (in chat panel / overlay)
```
═══ PvP COMBAT ═══
Round 3 — YOUR TURN

Sir Galahad (you)     DarkMage
HP: 18/25             HP: 12/20
ATK: 9  DEF: 5       ATK: 7  DEF: 4

Last: DarkMage attacks you for 4 damage!

[Attack] [Defend] [Heal] [Forfeit]

Time remaining: 58:42
```

When it's the opponent's turn:
```
═══ PvP COMBAT ═══
Round 4 — DarkMage's turn

Sir Galahad (you)     DarkMage
HP: 18/25             HP: 12/20

Waiting for opponent... (52:15 remaining)
```

### Combat End
```
═══ VICTORY ═══
DarkMage falls! You claim 21 gold!

Signing covenant update...
[TX: abc123...]
```

### Settlement (On-Chain)

After combat ends:
1. Both clients poll `/api/pvp/status` and see `status: "finished"`
2. Each client builds the ICC tx with the final state and signs their input
3. Each client POSTs their `sigScript` to `/api/pvp/sign`
4. When both sigs are in (`ready: true`), one client builds the full tx:
   - Input 0: Player A covenant (A's sig_script)
   - Input 1: Player B covenant (B's sig_script)
   - Output 0: New Player A state (final HP/gold from session)
   - Output 1: New Player B state (final HP/gold from session)
5. Submit tx via wRPC, POST txId to `/api/pvp/complete`

### Signature Coordination

The tricky part: both players must sign the SAME transaction. The tx must be
identical for both signatures to be valid. This means:

1. Server holds the canonical final state (a.hp, a.gold, b.hp, b.gold)
2. Both clients compute the same tx from this state
3. Both clients sign their respective inputs
4. One client (the winner) assembles and submits

To ensure identical txs:
- Use canonical input ordering: A = input 0, B = input 1
- Fee paid by A (winner typically)
- Both read final state from `/api/pvp/status`
- Both compute identical output scripts from the same state

## Edge Cases

| Case | Handling |
|---|---|
| Player disconnects mid-combat | Turn timer continues; timeout = forfeit |
| Both players online, one AFK | 1 hour timeout, then auto-forfeit |
| Player tries to act out of turn | Server returns 400 "not your turn" |
| Player challenges someone already in combat | Server should reject (TODO) |
| Player tries to challenge with stale covenant | UTXO check on settlement will fail; local state only |
| Settlement tx fails (stale UTXO) | Gold changes are final on server; UTXO update is best-effort |
| Server restarts mid-combat | Sessions persisted to `/root/pvp.json` |

## Files

| File | Purpose |
|---|---|
| `beacon-indexer.js` (droplet) | Server: all API endpoints, combat logic, persistence |
| `game/test.html` | Test page with full PvP UI |
| `game/index.html` | Live page (PvP added after testing) |
| `assets/js/game/covenant.js` | `registerPlayer()`, `getActivePlayers()`, ICC tx building |
| `assets/js/game/combat.js` | `SeededRng` class (shared with server) |

## Implementation Order

1. **Server** ✅ — combat session CRUD, actions, timeout, forfeit, signing
2. **Client: accept flow** ✅ — challenge, in-chat accept/decline buttons
3. **Client: combat UI** ✅ — poll pvp/status every 5s, renderCombatUI with HP bars, action buttons
4. **Client: settlement** ✅ — pvpSign + pvpAssembleAndSubmit, dual-sig ICC tx
5. **Testing** — two-browser test on test.html
6. **Polish** — turn countdown timer, combat animations, sound
7. **Merge to live** — add to index.html after testing

## Next Session: Testing Checklist

Test at https://dagknight.xyz/game/test.html with two browser windows.

### Verify server field names
- [ ] Check `/pvp/status` response shape — confirm `startHp`/`startGold` vs `maxHp`/`gold` for redeem scripts
- [ ] If server doesn't provide starting state separately, add `startHp`/`startGold` fields to session creation in beacon-indexer.js

### Two-browser flow
- [ ] Player A challenges Player B via PvP button in player list
- [ ] Player B sees challenge prompt in chat, clicks Accept
- [ ] Both players see combat UI appear (HP bars, round info)
- [ ] Turns alternate correctly — action buttons only show on your turn
- [ ] Attack/Defend/Heal/Forfeit all work, combat log updates
- [ ] Combat ends when HP reaches 0 — victory/defeat shown correctly
- [ ] Both clients auto-sign after combat ends
- [ ] ICC tx submits successfully with dual Schnorr sigs
- [ ] Local state (hp, gold) updates for both players
- [ ] Combat UI clears after ~10 seconds

### Edge cases
- [ ] Forfeit mid-combat — half-gold penalty applied correctly
- [ ] Refresh during combat — pollPvpStatus picks up existing session
- [ ] Challenge someone already in combat — server rejects
