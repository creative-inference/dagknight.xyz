/* ============================================================
   DAGKnight BBS — Combat System (KWP-ONLY)
   Uses KWP-5 Verifiable RNG. No local SeededRng fallback.
   ============================================================ */

// KWP-5 RNG — exposed globally for PvP code in test.html
const SeededRng = KWP.rng.SeededRng;

async function getCombatSeed() {
  try {
    const rpc = Covenant._rpc;
    if (!rpc) return null;
    return await KWP.rng.getBlockSeed(rpc);
  } catch { return null; }
}

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
