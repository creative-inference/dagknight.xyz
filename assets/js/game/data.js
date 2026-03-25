/* ============================================================
   DAGKnight BBS — Game Data
   Monsters, items, levels, ASCII art
   ============================================================ */

const TITLE_ART = `
 ██████╗  █████╗  ██████╗ ██╗  ██╗███╗   ██╗██╗ ██████╗ ██╗  ██╗████████╗
 ██╔══██╗██╔══██╗██╔════╝ ██║ ██╔╝████╗  ██║██║██╔════╝ ██║  ██║╚══██╔══╝
 ██║  ██║███████║██║  ███╗█████╔╝ ██╔██╗ ██║██║██║  ███╗███████║   ██║
 ██║  ██║██╔══██║██║   ██║██╔═██╗ ██║╚██╗██║██║██║   ██║██╔══██║   ██║
 ██████╔╝██║  ██║╚██████╔╝██║  ██╗██║ ╚████║██║╚██████╔╝██║  ██║   ██║
 ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝
`;

const SUBTITLE_ART = `        ─── A BlockDAG Door Game ───`;

const TOWN_ART = `
      .     *        .    *     .       *
  *       ╔═══════════════════╗       .
     .    ║  THE  DAG  GATE   ║   *
  *       ╚═══════════════════╝      .
       .  │  │  ┌──────┐  │  │   *
     *    │  │  │ ◊  ◊  │  │  │      .
  .       ├──┤  │  DAG  │  ├──┤   *
      *   │▓▓│  │ GATE  │  │▓▓│
  .       │▓▓│  ├──────┤  │▓▓│     .
     *    │▓▓│  │      │  │▓▓│  *
  ────────┴──┴──┴──────┴──┴──┴────────
`;

const DEATH_ART = `
    ╔═══════════════════════════╗
    ║   YOUR CHAIN WAS          ║
    ║       ORPHANED...         ║
    ╚═══════════════════════════╝
`;

const VICTORY_ART = `
   ★  ★  ★  ★  ★  ★  ★  ★  ★  ★  ★
   ╔═══════════════════════════════╗
   ║   DAGKNIGHT  COMMANDER        ║
   ║   The realm is yours.         ║
   ╚═══════════════════════════════╝
   ★  ★  ★  ★  ★  ★  ★  ★  ★  ★  ★
`;

const LEVELUP_ART = `
   ═══════════════════════════
    ◆  THE DAG CONFIRMS YOUR  ◆
    ◆     ASCENSION           ◆
   ═══════════════════════════
`;

const FOREST_ART = `
   /\\  /\\    /\\      /\\  /\\
  /  \\/  \\  /  \\    /  \\/  \\
 / /\\ /\\ \\/  /\\ \\  / /\\ /\\ \\
/ /  V  \\ \\/ /  \\ \\/ /  V  \\ \\
 THE  MERKLE  FOREST
`;

// ---------- Classes ----------

const CLASSES = {
  knight: { name: 'Knight', hp: 25, attack: 4, defense: 5, gold: 30, desc: '+HP, +DEF' },
  mage:   { name: 'Mage',   hp: 18, attack: 7, defense: 2, gold: 40, desc: '+ATK, +Gold' },
  rogue:  { name: 'Rogue',  hp: 20, attack: 5, defense: 3, gold: 60, desc: 'Balanced, +Gold' },
};

// ---------- Level table ----------

const LEVELS = [
  { level: 1,  xp: 0,      title: 'Unconfirmed Node' },
  { level: 2,  xp: 100,    title: 'Orphan Slayer' },
  { level: 3,  xp: 300,    title: 'Block Squire' },
  { level: 4,  xp: 600,    title: 'Hash Apprentice' },
  { level: 5,  xp: 1100,   title: 'Merkle Warden' },
  { level: 6,  xp: 1800,   title: 'Fork Sentinel' },
  { level: 7,  xp: 2800,   title: 'Consensus Knight' },
  { level: 8,  xp: 4200,   title: 'GhostDAG Paladin' },
  { level: 9,  xp: 6000,   title: 'Phantom Vanguard' },
  { level: 10, xp: 8500,   title: 'Reorg Slayer' },
  { level: 11, xp: 12000,  title: 'DAGKnight Elite' },
  { level: 12, xp: 17000,  title: 'DAGKnight Commander' },
];

// HP and stat gains per level
function statsForLevel(level, charClass) {
  const base = CLASSES[charClass] || CLASSES.knight;
  const scale = level - 1;
  return {
    maxHp: base.hp + scale * 5,
    attack: base.attack + scale * 2,
    defense: base.defense + scale * 1,
  };
}

function titleForLevel(level) {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (level >= LEVELS[i].level) return LEVELS[i].title;
  }
  return LEVELS[0].title;
}

function xpForNextLevel(level) {
  if (level >= 12) return Infinity;
  return LEVELS[level].xp; // LEVELS[level] is next level (0-indexed offset)
}

// ---------- Monsters ----------

const MONSTERS = [
  // Tier 1 (levels 1-3)
  { name: 'Shadow Wisp',    tier: 1, hp: 12, attack: 3,  defense: 1, xp: 20,  gold: 8  },
  { name: 'Orphan Block',   tier: 1, hp: 15, attack: 4,  defense: 2, xp: 25,  gold: 12 },
  { name: 'Rogue Node',     tier: 1, hp: 10, attack: 5,  defense: 1, xp: 22,  gold: 10 },
  { name: 'Stale Header',   tier: 1, hp: 18, attack: 3,  defense: 3, xp: 28,  gold: 15 },

  // Tier 2 (levels 4-6)
  { name: 'Chain Wraith',   tier: 2, hp: 30, attack: 8,  defense: 4, xp: 55,  gold: 30 },
  { name: 'Fork Specter',   tier: 2, hp: 25, attack: 10, defense: 3, xp: 60,  gold: 35 },
  { name: 'Sybil Knight',   tier: 2, hp: 35, attack: 7,  defense: 6, xp: 65,  gold: 40 },
  { name: 'Nonce Golem',    tier: 2, hp: 40, attack: 6,  defense: 5, xp: 50,  gold: 25 },

  // Tier 3 (levels 7-9)
  { name: 'Double-Spend Dragon', tier: 3, hp: 55, attack: 14, defense: 7,  xp: 120, gold: 80  },
  { name: 'Eclipse Phantom',     tier: 3, hp: 50, attack: 16, defense: 6,  xp: 130, gold: 90  },
  { name: 'DAG Hydra',           tier: 3, hp: 65, attack: 12, defense: 9,  xp: 140, gold: 100 },
  { name: 'Selfish Miner',       tier: 3, hp: 45, attack: 18, defense: 5,  xp: 110, gold: 70  },

  // Tier 4 (levels 10-12)
  { name: 'The Reorg Lord',      tier: 4, hp: 80,  attack: 20, defense: 10, xp: 250, gold: 200 },
  { name: "Nakamoto's Ghost",    tier: 4, hp: 90,  attack: 18, defense: 12, xp: 280, gold: 220 },
  { name: 'Finality Breaker',    tier: 4, hp: 100, attack: 22, defense: 11, xp: 300, gold: 250 },
  { name: '51% Colossus',        tier: 4, hp: 120, attack: 16, defense: 14, xp: 350, gold: 300 },
];

function monstersForLevel(level) {
  let tier;
  if (level <= 3) tier = 1;
  else if (level <= 6) tier = 2;
  else if (level <= 9) tier = 3;
  else tier = 4;
  // Include current tier and one below for variety
  return MONSTERS.filter(m => m.tier === tier || m.tier === tier - 1);
}

function randomMonster(level) {
  const pool = monstersForLevel(level);
  return { ...pool[Math.floor(Math.random() * pool.length)] };
}

// ---------- Items ----------

const WEAPONS = [
  { name: 'Rusty Dagger',        bonus: 1,  price: 0 },
  { name: 'Hash Blade',          bonus: 3,  price: 80 },
  { name: 'Merkle Sword',        bonus: 6,  price: 300 },
  { name: 'DAG Halberd',         bonus: 10, price: 800 },
  { name: 'Phantom Edge',        bonus: 15, price: 2000 },
  { name: 'Consensus Greatsword',bonus: 22, price: 5000 },
  { name: 'GhostDAG Reaper',     bonus: 30, price: 12000 },
];

const ARMORS = [
  { name: 'Cloth Tunic',         bonus: 1,  price: 0 },
  { name: 'Chain Vest',          bonus: 3,  price: 100 },
  { name: 'Block Plate',         bonus: 6,  price: 350 },
  { name: 'PHANTOM Shield',      bonus: 10, price: 900 },
  { name: 'GhostDAG Aegis',      bonus: 15, price: 2500 },
  { name: 'Covenant Armor',      bonus: 22, price: 6000 },
  { name: 'DAGKnight Regalia',   bonus: 30, price: 14000 },
];

const POTION_PRICE = 25;
const INN_BASE_PRICE = 15;

// ---------- PvP NPC ghosts ----------

const NPC_GHOSTS = [
  { name: 'Sir Hashington', charClass: 'knight', level: 2, attack: 8,  defense: 7,  maxHp: 30, weapon: WEAPONS[1], armor: ARMORS[1] },
  { name: 'Merkala',        charClass: 'mage',   level: 4, attack: 15, defense: 5,  maxHp: 33, weapon: WEAPONS[2], armor: ARMORS[1] },
  { name: 'BlockBane',      charClass: 'rogue',   level: 6, attack: 17, defense: 10, maxHp: 45, weapon: WEAPONS[3], armor: ARMORS[2] },
  { name: 'Lady Finality',  charClass: 'knight', level: 8, attack: 20, defense: 17, maxHp: 60, weapon: WEAPONS[4], armor: ARMORS[3] },
  { name: 'The Phantom',    charClass: 'mage',   level: 10, attack: 27, defense: 13, maxHp: 63, weapon: WEAPONS[5], armor: ARMORS[4] },
  { name: 'Satoshi',        charClass: 'rogue',  level: 12, attack: 33, defense: 22, maxHp: 75, weapon: WEAPONS[6], armor: ARMORS[5] },
];
