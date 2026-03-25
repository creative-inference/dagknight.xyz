/* ============================================================
   DAGKnight BBS — Game State (localStorage)
   ============================================================ */

const SAVE_KEY = 'dagknight_save';

const GameState = {
  save(state) {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  },

  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      // Daily fight reset
      const today = new Date().toISOString().slice(0, 10);
      if (state.lastPlayDate !== today) {
        state.forestFightsToday = 0;
        state.lastPlayDate = today;
      }
      return state;
    } catch {
      return null;
    }
  },

  reset() {
    localStorage.removeItem(SAVE_KEY);
  },

  newGame(name, charClass) {
    const cls = CLASSES[charClass] || CLASSES.knight;
    const stats = statsForLevel(1, charClass);
    return {
      name,
      charClass,
      level: 1,
      xp: 0,
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      attack: stats.attack,
      defense: stats.defense,
      gold: cls.gold,
      weapon: { ...WEAPONS[0] },
      armor: { ...ARMORS[0] },
      potions: 1,
      forestFightsToday: 0,
      forestFightsMax: 10,
      lastPlayDate: new Date().toISOString().slice(0, 10),
      kills: 0,
      deaths: 0,
      pvpWins: 0,
    };
  },

  checkLevelUp(state) {
    if (state.level >= 12) return false;
    const needed = xpForNextLevel(state.level);
    if (state.xp >= needed) {
      state.level++;
      const stats = statsForLevel(state.level, state.charClass);
      state.maxHp = stats.maxHp;
      state.attack = stats.attack;
      state.defense = stats.defense;
      state.hp = state.maxHp; // Full heal on level up
      if (state.level % 3 === 0) state.forestFightsMax += 2; // Bonus fights at 3,6,9,12
      return true;
    }
    return false;
  },
};
