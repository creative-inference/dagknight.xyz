/* ============================================================
   DAGKnight BBS — Screen Definitions
   Each screen function calls engine methods to render.
   ============================================================ */

// Safe chain emit — no-op if Chain isn't loaded yet
function chainEmit(action, detail, txId) {
  if (typeof Chain !== 'undefined') Chain.emitCovenantTx(action, detail, txId);
}

// Global chain sync lock — prevents overlapping covenant updates
let _chainBusy = false;

// ICC shop purchase: Player + Shop covenants in one atomic tx
async function shopPurchase(s, price, itemName) {
  if (_chainBusy || !Wallet._kaspa || !Wallet._privateKeyHex || !Wallet.funded) return;
  if (s._onChainHp === undefined || s._shopGoldCollected === undefined) {
    // Fall back to regular sync if no shop covenant
    return syncToChain(s, `Shop: ${itemName} -${price}g, gold=${s.gold}`);
  }
  try {
    const kaspa = Wallet._kaspa;
    const pk = new kaspa.PrivateKey(Wallet._privateKeyHex);
    const pub = pk.toPublicKey().toXOnlyPublicKey().toString();
    const ocHp = s._onChainHp; const ocGold = s._onChainGold; const ocLevel = s._onChainLevel;

    // Find both covenant UTXOs
    const playerAddr = Covenant.getCovenantAddress(kaspa, pub, ocHp, ocGold, ocLevel);
    const shopAddr = Covenant.getShopAddress(kaspa, s._shopGoldCollected);
    const playerUtxo = playerAddr ? await Covenant.findCovenantUtxo(playerAddr) : null;
    const shopUtxo = shopAddr ? await Covenant.findCovenantUtxo(shopAddr) : null;

    if (!playerUtxo || !shopUtxo) {
      return syncToChain(s, `Shop: ${itemName} -${price}g, gold=${s.gold}`);
    }

    const result = await Covenant.purchaseFromShop(
      kaspa, pk, pub, ocHp, ocGold, ocLevel,
      s.gold, price, playerUtxo, shopUtxo, s._shopGoldCollected
    );
    s._onChainHp = ocHp; s._onChainGold = s.gold; s._onChainLevel = ocLevel;
    s._shopGoldCollected += price;
    GameState.save(s);
    chainEmit('ICC: Player+Shop', `Atomic tx — ${price}g for ${itemName}`, result.transactionId);
  } catch (err) {
    console.log('ICC shop failed, falling back:', err.message);
    await syncToChain(s, `Shop: ${itemName} -${price}g, gold=${s.gold}`);
  }
}

// ICC PvP: Player + Opponent covenants in one atomic tx
async function pvpOnChain(s, newPlayerHp, newPlayerGold, opp, outcome) {
  if (_chainBusy || !Wallet._kaspa || !Wallet._privateKeyHex || !Wallet.funded) return;
  if (s._onChainHp === undefined || s._oppHp === undefined) {
    return syncToChain(s, `PvP ${outcome}: hp=${newPlayerHp} gold=${newPlayerGold}`);
  }
  try {
    const kaspa = Wallet._kaspa;
    const pk = new kaspa.PrivateKey(Wallet._privateKeyHex);
    const pub = pk.toPublicKey().toXOnlyPublicKey().toString();
    const ocHp = s._onChainHp; const ocGold = s._onChainGold; const ocLevel = s._onChainLevel;

    // Always do real UTXO lookups
    const playerAddr = Covenant.getCovenantAddress(kaspa, pub, ocHp, ocGold, ocLevel);
    let playerUtxo = playerAddr ? await Covenant.findCovenantUtxo(playerAddr) : null;

    const oppAddr = Covenant.getOpponentAddress(kaspa, s._oppHp, s._oppGold);
    let oppUtxo = oppAddr ? await Covenant.findCovenantUtxo(oppAddr) : null;

    if (!playerUtxo || !oppUtxo) {
      await new Promise(r => setTimeout(r, 3000));
      if (!playerUtxo) playerUtxo = playerAddr ? await Covenant.findCovenantUtxo(playerAddr) : null;
      if (!oppUtxo) oppUtxo = oppAddr ? await Covenant.findCovenantUtxo(oppAddr) : null;
    }

    if (!playerUtxo || !oppUtxo) {
      return syncToChain(s, `PvP ${outcome}: hp=${newPlayerHp} gold=${newPlayerGold}`);
    }

    const newOppHp = outcome === 'win' ? Math.max(1, s._oppHp - 10) : s._oppHp;
    const stake = opp.level * 50;
    const newOppGold = outcome === 'win' ? Math.max(0, s._oppGold - stake) : s._oppGold + stake;

    const result = await Covenant.pvpFight(
      kaspa, pk, pub, ocHp, ocGold, ocLevel,
      newPlayerHp, newPlayerGold,
      s._oppHp, s._oppGold, newOppHp, newOppGold,
      playerUtxo, oppUtxo
    );

    const txId = result.transactionId || '';
    s._onChainHp = newPlayerHp; s._onChainGold = newPlayerGold; s._onChainLevel = ocLevel;
    s._lastPlayerTxId = txId; s._lastPlayerAmount = result.playerOutputAmount;
    s._oppHp = newOppHp; s._oppGold = newOppGold;
    s._lastOppTxId = txId; s._lastOppIndex = 1; s._lastOppAmount = String(oppUtxo.utxoEntry.amount);
    GameState.save(s);
    chainEmit('ICC: Player+Opponent', `PvP ${outcome} — atomic state update`, txId);
  } catch (err) {
    console.log('ICC PvP failed, falling back:', err.message);
    await syncToChain(s, `PvP ${outcome}: hp=${newPlayerHp} gold=${newPlayerGold}`);
  }
}

// Sync game state to on-chain covenant UTXO
async function syncToChain(s, action) {
  if (!Wallet._kaspa || !Wallet._privateKeyHex || !Wallet.funded) return;
  const ocHp = s._onChainHp; const ocGold = s._onChainGold; const ocLevel = s._onChainLevel;
  if (ocHp === undefined) return;
  if (s.hp === ocHp && s.gold === ocGold && s.level === ocLevel) return;
  if (_chainBusy) return;
  _chainBusy = true;
  const newLevel = Math.max(s.level, ocLevel);
  try {
    const kaspa = Wallet._kaspa;
    const pk = new kaspa.PrivateKey(Wallet._privateKeyHex);
    const pub = pk.toPublicKey().toXOnlyPublicKey().toString();

    // Try real UTXO lookup first, fall back to cached outpoint
    const covAddr = Covenant.getCovenantAddress(kaspa, pub, ocHp, ocGold, ocLevel);
    let covUtxo = covAddr ? await Covenant.findCovenantUtxo(covAddr) : null;
    if (!covUtxo && s._lastPlayerTxId && s._lastPlayerAmount) {
      // Use cached outpoint — UTXO exists but not indexed yet
      const currentSpk = kaspa.ScriptBuilder.fromScript(Covenant.buildPlayerScript(pub, ocHp, ocGold, ocLevel)).createPayToScriptHashScript();
      covUtxo = {
        outpoint: { transactionId: s._lastPlayerTxId, index: 0 },
        utxoEntry: { amount: s._lastPlayerAmount, blockDaaScore: '0', isCoinbase: false, scriptPublicKey: currentSpk },
      };
    }
    if (!covUtxo) { _chainBusy = false; return; }

    const result = await Covenant.updatePlayerUtxo(kaspa, pk, pub, ocHp, ocGold, ocLevel, s.hp, s.gold, newLevel, covUtxo);
    const txId = result.transactionId || '';
    s._onChainHp = s.hp; s._onChainGold = s.gold; s._onChainLevel = newLevel;
    s._lastPlayerTxId = txId;
    s._lastPlayerAmount = result.playerOutputAmount;
    s._lastCovenantAddr = Covenant.getCovenantAddress(kaspa, pub, s.hp, s.gold, newLevel);
    GameState.save(s);
    chainEmit('Player::update', action, txId);
  } catch (err) {
    console.log('Chain sync skipped:', err.message);
  } finally {
    _chainBusy = false;
  }
}

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
    // WASM + node connection happens in screenTown
    await screenTown(true);
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

  E.blank();
  E.gold(`  Welcome, ${window._state.name} the ${CLASSES[classKey].name}.`);
  E.blank();

  // Fund player wallet on TN12
  const spin = E.spinner('Forging your identity on the BlockDAG...');
  try {
    const result = await Wallet.fund();
    if (result.alreadyFunded) {
      spin.stop('Wallet already funded on TN12.', 't-cyan');
    } else {
      spin.stop('1 KAS deposited to your wallet on TN12.', 't-cyan');
      E.dim(`  TX: ${result.txId.substring(0, 24)}...`);
    }
  } catch (err) {
    spin.stop(`Wallet funding skipped: ${err.message}`, 't-dim');
  }

  if (Wallet.address) {
    E.dim(`  Address: ${Wallet.address.substring(0, 30)}...`);
  }

  // Create Player covenant UTXO on TN12
  if (Wallet._kaspa && Wallet._privateKeyHex && Wallet.funded) {
    const covSpin = E.spinner('Inscribing covenant on the BlockDAG...');
    try {
      const kaspa = Wallet._kaspa;
      const pk = new kaspa.PrivateKey(Wallet._privateKeyHex);
      const pubkeyHex = pk.toPublicKey().toXOnlyPublicKey().toString();
      const s = window._state;
      // Connect to our TN12 node
      await Covenant.ensureRpc(kaspa);
      // Wait for faucet tx to confirm
      let utxos = await Covenant.getUtxos(Wallet.address);
      let retries = 0;
      while ((!utxos || utxos.length === 0) && retries < 10) {
        await new Promise(r => setTimeout(r, 2000));
        utxos = await Covenant.getUtxos(Wallet.address);
        retries++;
      }
      const result = await Covenant.createPlayerAndShop(
        kaspa, pk, pubkeyHex, s.hp, s.gold, 1, utxos
      );
      const txId = result.transactionId || '';
      s._onChainHp = s.hp; s._onChainGold = s.gold; s._onChainLevel = 1;
      s._lastPlayerTxId = txId; s._lastPlayerAmount = '10000000';
      s._lastCovenantAddr = Covenant.getCovenantAddress(kaspa, pubkeyHex, s.hp, s.gold, 1);
      s._shopGoldCollected = 0;
      s._oppHp = 50; s._oppGold = 100;
      s._lastOppTxId = txId; s._lastOppIndex = 2; s._lastOppAmount = '5000000';
      GameState.save(s);
      covSpin.stop('Player + Shop + Arena covenants created on TN12!', 't-cyan');
      E.dim(`  Covenant TX: ${txId.substring(0, 24)}...`);
      chainEmit('Player::create', `Player + Shop covenants deployed`, txId);
    } catch (err) {
      covSpin.stop(`Covenant creation skipped: ${err.message}`, 't-dim');
      chainEmit('Player::create (sim)', `${window._state.name} — localStorage only`);
    }
  } else {
    console.log('Covenant skip: kaspa:', !!Wallet._kaspa, 'key:', !!Wallet._privateKeyHex, 'funded:', Wallet.funded);
    chainEmit('Player::create (sim)', `${window._state.name} — localStorage only`);
  }

  E.blank();
  E.line('  The DAG Gate opens before you...');
  await E.pause();
  await screenTown();
}

// ----- Town -----
async function screenTown(verifyChain) {
  const s = window._state;
  E.clear();
  E.ascii(TOWN_ART);
  E.gold(`  ${s.name} the ${titleForLevel(s.level)}`);
  E.line(`  Level ${s.level}  |  HP: ${s.hp}/${s.maxHp}  |  Gold: ${s.gold}`);
  E.line(`  ATK: ${s.attack}+${s.weapon.bonus}  DEF: ${s.defense}+${s.armor.bonus}  |  Fights: ${s.forestFightsMax - s.forestFightsToday} left`);

  // Verify/load chain state on first town entry after Continue Quest
  if (verifyChain) {
    try {
      await Wallet.ensureAddress();
      if (Wallet._kaspa && Wallet._privateKeyHex) {
        const kaspa = Wallet._kaspa;
        await Covenant.ensureRpc(kaspa);
        const pk = new kaspa.PrivateKey(Wallet._privateKeyHex);
        const pub = pk.toPublicKey().toXOnlyPublicKey().toString();
        const chainState = await Covenant.loadFromChain(kaspa, pub, s);
        console.log('loadFromChain result:', chainState);
        if (chainState) {
          s.hp = chainState.hp;
          s.gold = chainState.gold;
          s.level = chainState.level;
          s._onChainHp = chainState.hp;
          s._onChainGold = chainState.gold;
          s._onChainLevel = chainState.level;
          s._lastCovenantAddr = chainState.address;
          GameState.save(s);
          chainEmit('Player::verified', `Covenant loaded from TN12: hp=${chainState.hp} gold=${chainState.gold} level=${chainState.level} (${chainState.amount} sompi)`, false);
          // Redraw stats with corrected values
          E.clear();
          E.ascii(TOWN_ART);
          E.gold(`  ${s.name} the ${titleForLevel(s.level)}`);
          E.line(`  Level ${s.level}  |  HP: ${s.hp}/${s.maxHp}  |  Gold: ${s.gold}`);
          E.line(`  ATK: ${s.attack}+${s.weapon.bonus}  DEF: ${s.defense}+${s.armor.bonus}  |  Fights: ${s.forestFightsMax - s.forestFightsToday} left`);
        }
      }
    } catch { /* silent */ }
  } else if (s._onChainLevel !== undefined) {
    chainEmit('Player::state', `hp=${s._onChainHp} gold=${s._onChainGold} level=${s._onChainLevel}`, false);
  }
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
  if (monster.trait) {
    const traitDesc = {
      glass: 'Fragile but hits hard', tank: 'Slow but absorbs punishment',
      regen: 'Regenerates HP each round', poison: 'Venomous — deals damage over time',
      armored: 'Heavy armor reduces damage', swift: 'Quick — may dodge attacks',
      drain: 'Steals your life force', enrage: 'Gets stronger when wounded',
    };
    E.dim(`  [${monster.trait.toUpperCase()}] ${traitDesc[monster.trait] || ''}`);
  }
  E.blank();
  E.line(`  HP: ${monster.hp}  ATK: ${monster.attack}  DEF: ${monster.defense}`);
  E.blank();
  E.dim(`  Fights remaining today: ${s.forestFightsMax - s.forestFightsToday}`);

  chainEmit('Game::encounter', `${monster.name} spawned (ICC coming soon)`);

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

    if (choice === 'A' || choice === 'D') {
      const atkMult = choice === 'D' ? 0.5 : 1;

      // Swift: chance to dodge player's attack
      if (monster.trait === 'swift' && Math.random() < 0.25) {
        log.push({ fn: E.dim.bind(E), text: `  The ${monster.name} dodges your attack!` });
      } else {
        const result = runCombatRound(
          { name: s.name, attack: Math.floor(s.attack * atkMult), weapon: s.weapon, defense: s.defense, armor: s.armor },
          { name: monster.name, attack: monster.attack, weapon: { bonus: 0 }, defense: monster.defense, armor: { bonus: 0 }, hp: monster.hp }
        );
        monster.hp = result.defenderHp;
        if (choice === 'D') {
          log.push({ fn: E.cyan.bind(E), text: `  You brace and counter for ${result.damage} damage!` });
        } else {
          log.push({ fn: E.gold.bind(E), text: `  You strike the ${monster.name} for ${result.damage} damage!` });
        }
        chainEmit('Game::combat', `Player → ${monster.name} | -${result.damage} HP (ZK coming soon)`);
      }
    }

    // Monster trait effects (pre-attack)
    if (monster.hp > 0 && monster.trait === 'regen') {
      const regen = Math.floor(monster.maxHp * 0.08);
      monster.hp = Math.min(monster.maxHp, monster.hp + regen);
      log.push({ fn: E.dim.bind(E), text: `  The ${monster.name} regenerates ${regen} HP.` });
    }
    if (monster.hp > 0 && monster.trait === 'enrage' && monster.hp < monster.maxHp * 0.4) {
      if (!monster._enraged) {
        monster._enraged = true;
        monster.attack = Math.floor(monster.attack * 1.5);
        log.push({ fn: E.red.bind(E), text: `  The ${monster.name} is ENRAGED! Attack increased!` });
      }
    }

    // Monster attacks back if alive
    if (monster.hp > 0 && choice !== 'R') {
      let defMult = choice === 'D' ? 0.5 : 1;
      let monsterAtk = monster.attack;
      const mDmg = Math.max(1, Math.floor(rollDamage(monsterAtk, 0, s.defense, s.armor.bonus) * defMult));
      s.hp = Math.max(0, s.hp - mDmg);
      log.push({ fn: E.red.bind(E), text: `  ${monster.name} hits you for ${mDmg} damage!` });

      // Drain: monster heals for portion of damage dealt
      if (monster.trait === 'drain') {
        const drained = Math.floor(mDmg * 0.3);
        monster.hp = Math.min(monster.maxHp, monster.hp + drained);
        log.push({ fn: E.dim.bind(E), text: `  The ${monster.name} drains ${drained} HP from you!` });
      }
      // Poison: lingering damage
      if (monster.trait === 'poison') {
        const poisonDmg = Math.max(1, Math.floor(s.maxHp * 0.05));
        s.hp = Math.max(0, s.hp - poisonDmg);
        log.push({ fn: E.dim.bind(E), text: `  Poison courses through you... ${poisonDmg} damage!` });
      }
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

    const leveled = GameState.checkLevelUp(s);
    if (leveled) {
      E.blank();
      E.ascii(LEVELUP_ART);
      E.gold(`  ★ LEVEL UP! You are now level ${s.level}!`);
      chainEmit('Player::level_up', `Level ${s.level} — ${titleForLevel(s.level)}`);
      E.gold(`  ★ Title: ${titleForLevel(s.level)}`);
      E.line(`  HP: ${s.maxHp}  ATK: ${s.attack}  DEF: ${s.defense}`);
      if (s.level >= 12) {
        E.blank();
        await screenVictory();
        return;
      }
    }

    GameState.save(s);
    await syncToChain(s, `Combat: hp=${s.hp} gold=${s.gold} level=${s.level}`);
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
  await syncToChain(s, `Death: hp=${s.hp} gold=${s.gold} (-${lostGold})`);
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
      GameState.save(s);
      await shopPurchase(s, POTION_PRICE, 'potion');
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
      GameState.save(s);
      await shopPurchase(s, selected.item.price, selected.item.name);
    } else {
      E.red('  Not enough gold!');
    }
  }
  await E.pause();
  await screenShop();
}

// ----- Inn -----

const TAVERN_RUMORS = [
  { speaker: 'A grizzled miner', lines: [
    '"I heard the Selfish Miner hoards blocks in a private chain."',
    '"Waits until he has enough, then releases them all at once."',
    '"The DAG makes it harder, but not impossible..."',
  ]},
  { speaker: 'A nervous merchant', lines: [
    '"The Double-Spend Dragon? Oh, it is real."',
    '"It attacks two targets at once with the same breath."',
    '"Only the DAGKnight protocol can stop it."',
  ]},
  { speaker: 'An old node operator', lines: [
    '"Back in my day, we had one block per second."',
    '"Now it is ten. Soon thirty-two."',
    '"The Merkle Forest grows faster than anyone can prune it."',
  ]},
  { speaker: 'A hooded figure', lines: [
    '"Every UTXO in this realm carries a covenant."',
    '"The covenants enforce the rules. Not the king. Not the sysop."',
    '"Just math. Pure, beautiful, trustless math."',
  ]},
  { speaker: 'A travelling bard', lines: [
    '"They say Nakamoto\'s Ghost wanders the highest tiers."',
    '"It guards the original genesis block."',
    '"No one has defeated it and lived to tell... well, except those who have."',
  ]},
  { speaker: 'A drunk validator', lines: [
    '"You know what ICC stands for? Inter-Covenant Communication!"',
    '"Two covenants, one transaction, zero trust."',
    '"I once saw a knight buy a sword and slay a dragon in the same block."',
  ]},
  { speaker: 'A quiet scribe', lines: [
    '"The Hash Bazaar merchant? His shop is a covenant too."',
    '"Every purchase is an atomic transaction."',
    '"He cannot cheat you. The L1 forbids it."',
  ]},
  { speaker: 'A wide-eyed apprentice', lines: [
    '"I tried to set my gold to a million. The covenant rejected it!"',
    '"require(newGold >= 0), it said."',
    '"The blockchain does not negotiate."',
  ]},
  { speaker: 'A scarred knight', lines: [
    '"The 51% Colossus is the final test."',
    '"One hundred and twenty hit points. Fourteen defense."',
    '"You will need every potion and every prayer to the DAG."',
  ]},
  { speaker: 'A fork philosopher', lines: [
    '"In the old world, games needed servers."',
    '"In this world, the BlockDAG is the server."',
    '"Your character sheet is a UTXO. Your sword is a state transition."',
  ]},
];

const TAVERN_EVENTS = [
  { text: 'A stranger challenges you to arm wrestling!', effect: (s) => {
    if (Math.random() < 0.5) {
      const gold = Math.floor(5 + s.level * 3);
      s.gold += gold;
      return { msg: `  You win! +${gold} gold.`, color: 'gold' };
    }
    return { msg: '  You lose. Your pride takes the hit, not your wallet.', color: 'dim' };
  }},
  { text: 'The barkeep offers you a mysterious brew...', effect: (s) => {
    const roll = Math.random();
    if (roll < 0.4) {
      const heal = Math.floor(s.maxHp * 0.2);
      s.hp = Math.min(s.maxHp, s.hp + heal);
      return { msg: `  It heals you! +${heal} HP.`, color: 'cyan' };
    } else if (roll < 0.7) {
      return { msg: '  It tastes terrible but does nothing.', color: 'dim' };
    }
    const dmg = Math.floor(s.maxHp * 0.1);
    s.hp = Math.max(1, s.hp - dmg);
    return { msg: `  It burns! -${dmg} HP. Never trust free drinks.`, color: 'red' };
  }},
  { text: 'You find a coin purse under the table!', effect: (s) => {
    const gold = Math.floor(10 + Math.random() * s.level * 5);
    s.gold += gold;
    return { msg: `  +${gold} gold! Finders keepers.`, color: 'gold' };
  }},
  { text: 'A bard plays a song about your deeds in the forest.', effect: (s) => {
    const xp = Math.floor(5 + s.level * 2);
    s.xp += xp;
    return { msg: `  You feel inspired. +${xp} XP.`, color: 'cyan' };
  }},
];

async function screenInn() {
  const s = window._state;

  while (true) {
    const cost = INN_BASE_PRICE + (s.level * 10);
    E.clear();
    E.gold('  === THE CONSENSUS TAVERN ===');
    E.blank();
    E.dim('  The fire crackles. Miners and validators');
    E.dim('  huddle over tankards of hashed ale.');
    E.blank();
    E.line(`  HP: ${s.hp}/${s.maxHp}  |  Gold: ${s.gold}`);
    E.blank();

    const opts = [];
    if (s.hp < s.maxHp) opts.push({ key: 'R', label: `Rest (${cost}g - full HP)` });
    opts.push({ key: 'T', label: 'Talk to someone' });
    opts.push({ key: 'B', label: 'Back to Town' });

    const choice = await E.menu(opts);

    if (choice === 'B') break;

    if (choice === 'T') {
      E.clear();
      E.gold('  === THE CONSENSUS TAVERN ===');
      E.blank();
      // 70% rumor, 30% event
      if (Math.random() < 0.7) {
        const rumor = TAVERN_RUMORS[Math.floor(Math.random() * TAVERN_RUMORS.length)];
        E.line(`  ${rumor.speaker} leans in:`);
        E.blank();
        for (const line of rumor.lines) {
          E.dim(`  ${line}`);
        }
      } else {
        const event = TAVERN_EVENTS[Math.floor(Math.random() * TAVERN_EVENTS.length)];
        E.line(`  ${event.text}`);
        E.blank();
        const result = event.effect(s);
        GameState.save(s);
        if (E[result.color]) E[result.color](result.msg); else E.line(result.msg);
        if (result.color === 'gold' || result.color === 'cyan') {
          await syncToChain(s, `Tavern: ${result.msg.trim()}`);
        }
      }
      await E.pause();
      continue;
    }

    if (choice === 'R') {
    if (s.gold >= cost) {
      s.gold -= cost;
      s.hp = s.maxHp;
      GameState.save(s);
      E.cyan(`  You rest deeply. HP fully restored to ${s.maxHp}.`);
      await syncToChain(s, `Inn: hp=${s.hp} gold=${s.gold} (-${cost}g)`);
    } else {
      E.red('  Not enough gold! The barkeep frowns.');
    }
      await E.pause();
    }
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
      GameState.save(s);
      await syncToChain(s, `PvP forfeit: hp=${s.hp} gold=${s.gold}`);
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
      chainEmit('Arena::combat', `Player → ${opp.name} | -${r1.damage} HP (ICC coming soon)`);
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
    await pvpOnChain(s, s.hp, s.gold, opp, 'loss');
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
    await pvpOnChain(s, s.hp, s.gold, opp, 'win');
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
