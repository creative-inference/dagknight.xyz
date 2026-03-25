/* ============================================================
   DAGKnight BBS — Screen Definitions
   Each screen function calls engine methods to render.
   ============================================================ */

// ----- Title Screen -----
async function screenTitle() {
  E.clear();
  E.ascii(TITLE_ART);
  E.ascii(SUBTITLE_ART);
  E.blank();
  E.dim('  In the year 10 BPS, the BlockDAG realm stands');
  E.dim('  at the edge of consensus. Knights are needed.');
  E.blank();

  const hasSave = GameState.load() !== null;
  const opts = [];
  if (hasSave) opts.push({ key: 'C', label: 'Continue Quest' });
  opts.push({ key: 'N', label: 'New Game' });
  opts.push({ key: 'A', label: 'About' });

  const choice = await E.menu(opts);
  if (choice === 'C') {
    window._state = GameState.load();
    await screenTown();
  } else if (choice === 'N') {
    await screenNewGame();
  } else {
    await screenAbout();
  }
}

// ----- About Screen -----
async function screenAbout() {
  E.clear();
  E.gold('  === ABOUT THE DAG GATE ===');
  E.blank();
  E.line('  This game is a tribute to Legend of the Red Dragon,');
  E.line('  the classic BBS door game by Seth Able (1992).');
  E.blank();
  E.line('  In 1991, LORD needed a BBS server.');
  E.line('  In 2026, the BlockDAG is the server.');
  E.blank();
  E.line('  Every fight, every trade, every character sheet');
  E.line('  will become a covenant-enforced UTXO.');
  E.line('  No trusted host. No admin. Just math.');
  E.blank();
  E.dim('  Phase 1: Client-side demo (you are here)');
  E.dim('  Phase 2: On-chain via Kaspa covenants + ICC');
  E.blank();
  E.cyan('  vprogs.xyz  |  blockdag.xyz  |  dagknight.xyz');
  E.blank();
  const choice = await E.menu([{ key: 'B', label: 'Back' }]);
  await screenTitle();
}

// ----- New Game -----
async function screenNewGame() {
  E.clear();
  E.gold('  === CREATE YOUR KNIGHT ===');
  E.blank();
  const name = await E.prompt('  Enter thy name: ');
  if (!name || !name.trim()) { await screenTitle(); return; }

  E.blank();
  E.line('  Choose thy class:');
  E.blank();

  const opts = Object.entries(CLASSES).map(([key, cls]) => ({
    key: key[0].toUpperCase(),
    label: `${cls.name} (${cls.desc})`
  }));

  const choice = await E.menu(opts);
  const classKey = Object.keys(CLASSES).find(k => k[0].toUpperCase() === choice);

  window._state = GameState.newGame(name.trim().slice(0, 20), classKey);
  GameState.save(window._state);
  Chain.emitCovenantTx('Player::create', `New Player UTXO — ${window._state.name} the ${CLASSES[classKey].name}`);

  E.blank();
  E.gold(`  Welcome, ${window._state.name} the ${CLASSES[classKey].name}.`);
  E.line('  The DAG Gate opens before you...');
  await E.pause();
  await screenTown();
}

// ----- Town -----
async function screenTown() {
  const s = window._state;
  E.clear();
  E.ascii(TOWN_ART);
  E.gold(`  ${s.name} the ${titleForLevel(s.level)}`);
  E.line(`  Level ${s.level}  |  HP: ${s.hp}/${s.maxHp}  |  Gold: ${s.gold}`);
  E.line(`  ATK: ${s.attack}+${s.weapon.bonus}  DEF: ${s.defense}+${s.armor.bonus}  |  Fights: ${s.forestFightsMax - s.forestFightsToday} left`);
  E.blank();

  const opts = [
    { key: 'F', label: 'Enter the Merkle Forest' },
    { key: 'S', label: 'The Hash Bazaar (Shop)' },
    { key: 'I', label: 'The Consensus Tavern (Inn)' },
    { key: 'P', label: 'The Byzantine Colosseum (PvP)' },
    { key: 'C', label: 'Character Sheet' },
    { key: 'Q', label: 'Save & Quit' },
  ];

  const choice = await E.menu(opts);
  if (choice === 'F') await screenForest();
  else if (choice === 'S') await screenShop();
  else if (choice === 'I') await screenInn();
  else if (choice === 'P') await screenPvP();
  else if (choice === 'C') await screenStats();
  else if (choice === 'Q') {
    GameState.save(s);
    E.clear();
    E.gold('  Quest saved. The DAG remembers.');
    E.dim('  Return tomorrow for more fights.');
  }
}

// ----- Forest -----
async function screenForest() {
  const s = window._state;
  E.clear();

  if (s.forestFightsToday >= s.forestFightsMax) {
    E.line('  The Merkle Forest grows dark...');
    E.line('  You have exhausted your daily fights.');
    E.dim('  Return tomorrow when the DAG resets.');
    await E.pause();
    await screenTown();
    return;
  }

  if (s.hp <= 0) {
    E.red('  You are too wounded to venture forth.');
    E.dim('  Visit the Consensus Tavern to rest.');
    await E.pause();
    await screenTown();
    return;
  }

  E.ascii(FOREST_ART);
  E.blank();
  E.line('  You step into the Merkle Forest...');
  E.line('  Leaves hash in the wind. Branches fork overhead.');
  E.blank();

  const monster = randomMonster(s.level);
  E.red(`  ★ A ${monster.name} emerges from the shadows!`);
  E.blank();
  E.line(`  HP: ${monster.hp}  ATK: ${monster.attack}  DEF: ${monster.defense}`);
  E.blank();
  E.dim(`  Fights remaining today: ${s.forestFightsMax - s.forestFightsToday}`);

  Chain.emitCovenantTx('Game::encounter', `Episodic Game UTXO created — ${monster.name} spawned`);

  const choice = await E.menu([
    { key: 'F', label: 'Fight!' },
    { key: 'R', label: 'Run back to town' },
  ]);

  if (choice === 'R') {
    await screenTown();
    return;
  }

  await screenCombat(monster);
}

// ----- Combat -----
async function screenCombat(monster) {
  const s = window._state;
  const monsterMax = monster.hp;
  let log = []; // last round's action log

  let round = 0;

  while (s.hp > 0 && monster.hp > 0) {
    round++;
    // Redraw entire combat screen each round
    E.clear();
    E.ascii(FOREST_ART);
    if (round === 1) {
      E.red(`  ★ A ${monster.name} emerges from the shadows!`);
    } else {
      E.dim(`  Round ${round} in the Merkle Forest`);
    }
    E.blank();
    E.gold(`  ═══ COMBAT ═══`);
    E.blank();
    E.line(`  ${s.name.padEnd(20)}  ${monster.name}`);
    E.line(`  HP: ${s.hp}/${s.maxHp}${' '.repeat(14 - String(s.hp).length - String(s.maxHp).length)}HP: ${monster.hp}/${monsterMax}`);
    E.line(`  ATK: ${s.attack}+${s.weapon.bonus}${' '.repeat(15 - String(s.attack).length - String(s.weapon.bonus).length)}ATK: ${monster.attack}`);
    E.line(`  DEF: ${s.defense}+${s.armor.bonus}${' '.repeat(15 - String(s.defense).length - String(s.armor.bonus).length)}DEF: ${monster.defense}`);
    E.blank();

    // Show last round's log
    if (log.length > 0) {
      E.dim('  --- Last Round ---');
      log.forEach(l => l.fn(l.text));
      E.blank();
    }

    const opts = [
      { key: 'A', label: 'Attack' },
      { key: 'D', label: 'Defend (half damage taken)' },
    ];
    if (s.potions > 0) opts.push({ key: 'H', label: `Heal Potion (${s.potions} left)` });
    opts.push({ key: 'R', label: 'Run away' });

    const choice = await E.menu(opts);
    log = [];

    if (choice === 'R') {
      if (Math.random() < 0.5) {
        E.clear();
        E.dim('  You flee from battle!');
        await E.pause();
        await screenTown();
        return;
      } else {
        log.push({ fn: E.red.bind(E), text: '  You failed to escape!' });
      }
    }

    if (choice === 'H') {
      const heal = Math.floor(s.maxHp * 0.4);
      s.hp = Math.min(s.maxHp, s.hp + heal);
      s.potions--;
      log.push({ fn: E.cyan.bind(E), text: `  You drink a potion and restore ${heal} HP.` });
    }

    if (choice === 'A') {
      const result = runCombatRound(
        { name: s.name, attack: s.attack, weapon: s.weapon, defense: s.defense, armor: s.armor },
        { name: monster.name, attack: monster.attack, weapon: { bonus: 0 }, defense: monster.defense, armor: { bonus: 0 }, hp: monster.hp }
      );
      monster.hp = result.defenderHp;
      log.push({ fn: E.gold.bind(E), text: `  You strike the ${monster.name} for ${result.damage} damage!` });
      Chain.emitCovenantTx('Game::combat', `Player → ${monster.name} | -${result.damage} HP | ZK proof validated`);
    }

    // Monster attacks back if alive
    if (monster.hp > 0 && choice !== 'R') {
      let defMult = choice === 'D' ? 0.5 : 1;
      const mDmg = Math.max(1, Math.floor(rollDamage(monster.attack, 0, s.defense, s.armor.bonus) * defMult));
      s.hp = Math.max(0, s.hp - mDmg);
      log.push({ fn: E.red.bind(E), text: `  ${monster.name} hits you for ${mDmg} damage!` });
    }
  }

  if (s.hp <= 0) {
    await screenDeath();
  } else {
    // Victory
    s.forestFightsToday++;
    s.kills++;
    s.xp += monster.xp;
    s.gold += monster.gold;
    E.gold(`  ★ Victory! The ${monster.name} is defeated!`);
    E.line(`  +${monster.xp} XP  +${monster.gold} gold`);
    Chain.emitCovenantTx('Player::state_update', `+${monster.xp} XP, +${monster.gold} gold → Player UTXO recreated`);

    const leveled = GameState.checkLevelUp(s);
    if (leveled) {
      E.blank();
      E.ascii(LEVELUP_ART);
      E.gold(`  ★ LEVEL UP! You are now level ${s.level}!`);
      Chain.emitCovenantTx('Player::level_up', `Level ${s.level} — ${titleForLevel(s.level)} | Stats recalculated via ZK proof`);
      E.gold(`  ★ Title: ${titleForLevel(s.level)}`);
      E.line(`  HP: ${s.maxHp}  ATK: ${s.attack}  DEF: ${s.defense}`);
      if (s.level >= 12) {
        E.blank();
        await screenVictory();
        return;
      }
    }

    GameState.save(s);
    E.blank();
    E.dim(`  Fights remaining today: ${s.forestFightsMax - s.forestFightsToday}`);

    const opts = [{ key: 'T', label: 'Return to Town' }];
    if (s.forestFightsToday < s.forestFightsMax && s.hp > 0) {
      opts.unshift({ key: 'F', label: 'Fight again' });
    }
    const next = await E.menu(opts);
    if (next === 'F') await screenForest();
    else await screenTown();
  }
}

// ----- Death -----
async function screenDeath() {
  const s = window._state;
  s.deaths++;
  const lostGold = Math.floor(s.gold * 0.2);
  s.gold -= lostGold;
  s.hp = Math.max(1, Math.floor(s.maxHp * 0.25));
  GameState.save(s);

  E.clear();
  E.ascii(DEATH_ART);
  E.red('  Your blocks were orphaned by the network.');
  E.red('  You collapse at the edge of the Merkle Forest.');
  E.blank();
  E.dim(`  The innkeeper drags you back. You lost ${lostGold} gold.`);
  E.line(`  HP restored to ${s.hp}/${s.maxHp}`);
  await E.pause();
  await screenTown();
}

// ----- Victory -----
async function screenVictory() {
  E.clear();
  E.ascii(VICTORY_ART);
  E.blank();
  E.gold('  You have achieved full consensus.');
  E.gold('  The BlockDAG bends to your will.');
  E.blank();
  E.line('  In 1991, LORD needed a BBS server.');
  E.line('  In 2026, the BlockDAG is the server.');
  E.blank();
  E.cyan('  Every fight was a state transition.');
  E.cyan('  Every level-up, a covenant-enforced UTXO.');
  E.cyan('  No trusted host. No admin. Just math.');
  E.blank();
  E.dim('  Phase 2: Play for real KAS on Kaspa mainnet.');
  E.blank();
  const choice = await E.menu([
    { key: 'N', label: 'Start New Game' },
    { key: 'Q', label: 'Quit' },
  ]);
  if (choice === 'N') {
    GameState.reset();
    await screenTitle();
  } else {
    E.gold('  The DAG remembers, always.');
  }
}

// ----- Shop -----
async function screenShop() {
  const s = window._state;
  E.clear();
  E.gold('  === THE HASH BAZAAR ===');
  E.blank();
  E.dim('  "Greetings, traveler. Only the finest');
  E.dim('   covenant-forged equipment here."');
  E.blank();

  const choice = await E.menu([
    { key: 'W', label: 'Weapons' },
    { key: 'A', label: 'Armor' },
    { key: 'P', label: `Heal Potions (${POTION_PRICE}g each)` },
    { key: 'B', label: 'Back to Town' },
  ]);

  if (choice === 'B') { await screenTown(); return; }

  if (choice === 'P') {
    if (s.gold >= POTION_PRICE) {
      s.gold -= POTION_PRICE;
      s.potions++;
      E.cyan(`  Purchased! You now have ${s.potions} potions. Gold: ${s.gold}`);
      Chain.emitCovenantTx('ICC: Player+Shop', `Atomic tx — ${POTION_PRICE}g → Shop, potion → Player`);
      GameState.save(s);
    } else {
      E.red('  Not enough gold!');
    }
    await E.pause();
    await screenShop();
    return;
  }

  const items = choice === 'W' ? WEAPONS : ARMORS;
  const equipped = choice === 'W' ? s.weapon : s.armor;
  E.blank();
  E.line(`  Gold: ${s.gold}  |  Equipped: ${equipped.name} (+${equipped.bonus})`);
  E.blank();

  const opts = items.filter(i => i.price > 0 && i.bonus > equipped.bonus).map((item, idx) => ({
    key: String(idx + 1),
    label: `${item.name} (+${item.bonus}) - ${item.price}g`,
    item,
  }));
  opts.push({ key: 'B', label: 'Back' });

  const pick = await E.menu(opts);
  if (pick === 'B') { await screenShop(); return; }

  const selected = opts.find(o => o.key === pick);
  if (selected && selected.item) {
    if (s.gold >= selected.item.price) {
      s.gold -= selected.item.price;
      if (choice === 'W') s.weapon = { ...selected.item };
      else s.armor = { ...selected.item };
      E.gold(`  Equipped ${selected.item.name}!`);
      Chain.emitCovenantTx('ICC: Player+Shop', `Atomic tx — ${selected.item.price}g → Shop, ${selected.item.name} → Player`);
      GameState.save(s);
    } else {
      E.red('  Not enough gold!');
    }
  }
  await E.pause();
  await screenShop();
}

// ----- Inn -----
async function screenInn() {
  const s = window._state;
  const cost = INN_BASE_PRICE + (s.level * 10);
  E.clear();
  E.gold('  === THE CONSENSUS TAVERN ===');
  E.blank();
  E.dim('  "Rest here, knight. Let your state');
  E.dim('   synchronize with the network."');
  E.blank();
  E.line(`  HP: ${s.hp}/${s.maxHp}  |  Gold: ${s.gold}`);
  E.line(`  Full rest costs ${cost} gold.`);
  E.blank();

  if (s.hp >= s.maxHp) {
    E.dim('  You are already at full health.');
    await E.pause();
    await screenTown();
    return;
  }

  const choice = await E.menu([
    { key: 'R', label: `Rest (${cost}g - full HP)` },
    { key: 'B', label: 'Back to Town' },
  ]);

  if (choice === 'R') {
    if (s.gold >= cost) {
      s.gold -= cost;
      s.hp = s.maxHp;
      GameState.save(s);
      E.cyan(`  You rest deeply. HP fully restored to ${s.maxHp}.`);
      Chain.emitCovenantTx('Player::inn_rest', `1:1 transition — HP ${s.maxHp}/${s.maxHp}, -${cost}g`);
    } else {
      E.red('  Not enough gold! The barkeep frowns.');
    }
    await E.pause();
  }
  await screenTown();
}

// ----- PvP -----
async function screenPvP() {
  const s = window._state;
  E.clear();
  E.gold('  === THE BYZANTINE COLOSSEUM ===');
  E.blank();
  E.dim('  "Prove your consensus against the ghosts');
  E.dim('   of warriors past..."');
  E.blank();

  // Filter NPCs to reasonable challenge range
  const available = NPC_GHOSTS.filter(n => n.level <= s.level + 2 && n.level >= s.level - 2);
  if (available.length === 0) {
    E.dim('  No worthy challengers at your level.');
    await E.pause();
    await screenTown();
    return;
  }

  const opts = available.map((npc, i) => ({
    key: String(i + 1),
    label: `${npc.name} (Lvl ${npc.level} ${CLASSES[npc.charClass].name})`,
    npc,
  }));
  opts.push({ key: 'B', label: 'Back to Town' });

  const pick = await E.menu(opts);
  if (pick === 'B') { await screenTown(); return; }

  const sel = opts.find(o => o.key === pick);
  if (!sel || !sel.npc) { await screenTown(); return; }

  const opp = { ...sel.npc, hp: sel.npc.maxHp, name: sel.npc.name };
  E.blank();
  E.red(`  ${opp.name} enters the arena!`);
  E.dim(`  HP: ${opp.maxHp}  ATK: ${opp.attack}+${opp.weapon.bonus}  DEF: ${opp.defense}+${opp.armor.bonus}`);
  E.blank();

  // PvP combat loop — redraws each round like forest combat
  let pvpLog = [];

  while (s.hp > 0 && opp.hp > 0) {
    E.clear();
    E.gold('  === THE BYZANTINE COLOSSEUM ===');
    E.blank();
    E.line(`  ${s.name.padEnd(20)}  ${opp.name}`);
    E.line(`  HP: ${s.hp}/${s.maxHp}${' '.repeat(14 - String(s.hp).length - String(s.maxHp).length)}HP: ${opp.hp}/${opp.maxHp}`);
    E.line(`  ATK: ${s.attack}+${s.weapon.bonus}${' '.repeat(15 - String(s.attack).length - String(s.weapon.bonus).length)}ATK: ${opp.attack}+${opp.weapon.bonus}`);
    E.line(`  DEF: ${s.defense}+${s.armor.bonus}${' '.repeat(15 - String(s.defense).length - String(s.armor.bonus).length)}DEF: ${opp.defense}+${opp.armor.bonus}`);
    E.blank();

    if (pvpLog.length > 0) {
      E.dim('  --- Last Round ---');
      pvpLog.forEach(l => l.fn(l.text));
      E.blank();
    }

    const cOpts = [{ key: 'A', label: 'Attack' }];
    if (s.potions > 0) cOpts.push({ key: 'H', label: `Heal Potion (${s.potions})` });
    cOpts.push({ key: 'R', label: 'Forfeit' });

    const ch = await E.menu(cOpts);
    pvpLog = [];

    if (ch === 'R') {
      E.clear();
      E.dim('  You forfeit the match.');
      await E.pause();
      await screenTown();
      return;
    }

    if (ch === 'H') {
      const heal = Math.floor(s.maxHp * 0.4);
      s.hp = Math.min(s.maxHp, s.hp + heal);
      s.potions--;
      pvpLog.push({ fn: E.cyan.bind(E), text: `  Healed ${heal} HP.` });
    }

    if (ch === 'A') {
      const r1 = runCombatRound(
        { name: s.name, attack: s.attack, weapon: s.weapon, defense: s.defense, armor: s.armor },
        { name: opp.name, attack: opp.attack, weapon: opp.weapon, defense: opp.defense, armor: opp.armor, hp: opp.hp }
      );
      opp.hp = r1.defenderHp;
      pvpLog.push({ fn: E.gold.bind(E), text: `  You strike ${opp.name} for ${r1.damage}!` });
      Chain.emitCovenantTx('Arena::combat', `Player → ${opp.name} | -${r1.damage} HP`);
    }

    if (opp.hp > 0) {
      const r2 = runCombatRound(
        { name: opp.name, attack: opp.attack, weapon: opp.weapon, defense: opp.defense, armor: opp.armor },
        { name: s.name, attack: s.attack, weapon: s.weapon, defense: s.defense, armor: s.armor, hp: s.hp }
      );
      s.hp = r2.defenderHp;
      pvpLog.push({ fn: E.red.bind(E), text: `  ${opp.name} hits you for ${r2.damage}!` });
    }
  }

  if (s.hp <= 0) {
    E.red('  Defeated in the arena!');
    s.hp = Math.max(1, Math.floor(s.maxHp * 0.1));
    GameState.save(s);
    await E.pause();
    await screenTown();
  } else {
    const reward = opp.level * 50;
    s.gold += reward;
    s.pvpWins++;
    s.xp += opp.level * 30;
    GameState.checkLevelUp(s);
    GameState.save(s);
    E.gold(`  ★ ${opp.name} falls! +${reward} gold, +${opp.level * 30} XP`);
    Chain.emitCovenantTx('ICC: Arena+Player+Player', `PvP resolved — ${s.name} wins, +${reward}g stake released`);
    await E.pause();
    await screenTown();
  }
}

// ----- Stats -----
async function screenStats() {
  const s = window._state;
  E.clear();
  E.gold('  === CHARACTER SHEET ===');
  E.blank();
  E.line(`  Name:    ${s.name}`);
  E.line(`  Class:   ${CLASSES[s.charClass].name}`);
  E.line(`  Title:   ${titleForLevel(s.level)}`);
  E.line(`  Level:   ${s.level}`);

  const nextXp = xpForNextLevel(s.level);
  const xpStr = nextXp === Infinity ? `${s.xp} (MAX)` : `${s.xp} / ${nextXp}`;
  E.line(`  XP:      ${xpStr}`);
  E.blank();
  E.line(`  HP:      ${s.hp} / ${s.maxHp}`);
  E.line(`  Attack:  ${s.attack} (+${s.weapon.bonus} weapon)`);
  E.line(`  Defense: ${s.defense} (+${s.armor.bonus} armor)`);
  E.blank();
  E.line(`  Weapon:  ${s.weapon.name}`);
  E.line(`  Armor:   ${s.armor.name}`);
  E.line(`  Potions: ${s.potions}`);
  E.line(`  Gold:    ${s.gold}`);
  E.blank();
  E.dim(`  Kills: ${s.kills}  Deaths: ${s.deaths}  PvP Wins: ${s.pvpWins}`);
  E.dim(`  Daily fights: ${s.forestFightsMax - s.forestFightsToday} remaining`);
  E.blank();

  await E.menu([{ key: 'B', label: 'Back to Town' }]);
  await screenTown();
}
