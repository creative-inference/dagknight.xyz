/* ============================================================
   DAGKnight BBS — Combat System
   Deterministic combat seeded from BlockDAG block hash.
   Anyone can replay and verify outcomes given the seed.
   ============================================================ */

// Seeded PRNG (xorshift64) — deterministic from a 64-bit seed
class SeededRng {
  constructor(seed) {
    // Convert any string to a BigInt state via simple hash
    if (typeof seed === 'string') {
      let h = 0n;
      for (let i = 0; i < seed.length; i++) {
        h = ((h << 5n) - h + BigInt(seed.charCodeAt(i))) & 0xFFFFFFFFFFFFFFFFn;
      }
      this.state = h || 1n;
    } else {
      this.state = BigInt(seed) || 1n;
    }
  }
  // Returns 0..max-1
  next(max) {
    // xorshift64
    this.state ^= this.state << 13n;
    this.state ^= this.state >> 7n;
    this.state ^= this.state << 17n;
    this.state &= 0xFFFFFFFFFFFFFFFFn; // keep 64-bit
    return Number(((this.state < 0n ? -this.state : this.state) % BigInt(max)));
  }
  // Returns float 0..1
  nextFloat() {
    return this.next(1000000) / 1000000;
  }
}

// Get combat seed from BlockDAG — uses virtual selected parent hash
async function getCombatSeed() {
  try {
    const rpc = Covenant._rpc;
    if (!rpc) return null;
    const info = await rpc.getBlockDagInfo();
    return info.tipHashes?.[0] || info.virtualParentHashes?.[0] || null;
  } catch { return null; }
}

// Deterministic monster selection from seed + player level
function seededMonster(seed, level) {
  const rng = new SeededRng(seed);
  const pool = monstersForLevel(level);
  const idx = rng.next(pool.length);
  const m = { ...pool[idx] };
  m.maxHp = m.hp;
  return m;
}

function rollDamage(attackStat, weaponBonus, defStat, armorBonus, rng) {
  const r = rng || { next: (n) => Math.floor(Math.random() * n) };
  const raw = r.next(attackStat + weaponBonus) + 1;
  const block = r.next(defStat + armorBonus + 1);
  return Math.max(1, raw - block);
}

function runCombatRound(attacker, defender, rng) {
  const dmg = rollDamage(
    attacker.attack, attacker.weapon.bonus,
    defender.defense, defender.armor.bonus,
    rng
  );
  defender.hp = Math.max(0, defender.hp - dmg);
  return { attacker: attacker.name, defender: defender.name, damage: dmg, defenderHp: defender.hp };
}
