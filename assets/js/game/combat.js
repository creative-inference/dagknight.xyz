/* ============================================================
   DAGKnight BBS — Combat System
   ============================================================ */

function rollDamage(attackStat, weaponBonus, defStat, armorBonus) {
  const raw = Math.floor(Math.random() * (attackStat + weaponBonus)) + 1;
  const block = Math.floor(Math.random() * (defStat + armorBonus));
  return Math.max(1, raw - block);
}

function runCombatRound(attacker, defender) {
  // attacker hits defender
  const dmg = rollDamage(
    attacker.attack, attacker.weapon.bonus,
    defender.defense, defender.armor.bonus
  );
  defender.hp = Math.max(0, defender.hp - dmg);
  return { attacker: attacker.name, defender: defender.name, damage: dmg, defenderHp: defender.hp };
}
