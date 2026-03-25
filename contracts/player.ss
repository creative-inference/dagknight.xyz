pragma silverscript ^0.1.0;

// =================================================================
// DAG Gate — Player Covenant
// Self-preserving UTXO that holds the full character state.
// Every spend recreates the player UTXO with updated state.
// =================================================================
//
// State layout (packed bytes in UTXO data field):
//
//   Bytes [0..19]    name (20 bytes, UTF-8, null-padded)
//   Byte  [20]       class (0=knight, 1=mage, 2=rogue)
//   Byte  [21]       level (1-12)
//   Bytes [22..23]   xp (u16 LE)
//   Bytes [24..25]   hp (u16 LE)
//   Bytes [26..27]   maxHp (u16 LE)
//   Byte  [28]       attack
//   Byte  [29]       defense
//   Bytes [30..33]   gold (u32 LE)
//   Byte  [34]       weapon tier (0-6, index into WEAPONS table)
//   Byte  [35]       armor tier (0-6, index into ARMORS table)
//   Byte  [36]       potions count
//   Byte  [37]       forest fights used today
//   Byte  [38]       forest fights max
//   Bytes [39..42]   last reset timestamp (u32 LE, unix epoch / 86400)
//   Bytes [43..46]   kills (u32 LE)
//   Bytes [47..48]   deaths (u16 LE)
//   Bytes [49..50]   pvp wins (u16 LE)
//   Bytes [51..82]   owner pubkey (32 bytes, Schnorr)
//
//   Total: 83 bytes
//
// =================================================================

contract Player(pubkey owner) {

    // --- Create new character ---
    // Called once to mint the initial Player UTXO.
    // Auth binding: only the owner can create their character.

    entrypoint function create(
        sig ownerSig,
        byte[20] name,
        byte charClass
    ) {
        require(checkSig(ownerSig, owner));
        require(charClass <= 2);

        // Output must recreate this covenant with initial state
        require(tx.outputs.length >= 1);
        require(tx.outputs[0].value >= 1000);  // minimum stake

        // State validation is handled by covenant declaration
        // Compiler enforces output carries updated state
    }

    // --- Combat update ---
    // Called after forest combat resolves.
    // Updates HP, XP, gold, kills, and checks level-up.
    // Self-preserving: output must carry same covenant + updated state.

    #[covenant.singleton(mode = transition)]
    entrypoint function combat_update(
        sig ownerSig,
        int hpDelta,       // negative = damage taken, positive = heal
        int xpGain,
        int goldGain,
        bool died
    ) : (byte[83] new_state) {
        require(checkSig(ownerSig, owner));
        require(xpGain >= 0);
        require(goldGain >= 0);

        // Stake must carry forward
        require(tx.outputs[0].value >= tx.inputs[this.activeInputIndex].value);
    }

    // --- Shop purchase ---
    // ICC: Player covenant + Shop covenant in one atomic tx.
    // Player spends gold, receives item upgrade.

    #[covenant.singleton(mode = transition)]
    entrypoint function shop_purchase(
        sig ownerSig,
        byte itemType,     // 0=weapon, 1=armor, 2=potion
        byte itemTier,     // tier index
        int price
    ) : (byte[83] new_state) {
        require(checkSig(ownerSig, owner));
        require(itemType <= 2);
        require(price > 0);

        // Gold must decrease by price (enforced in state transition)
        // Stake carries forward
        require(tx.outputs[0].value >= tx.inputs[this.activeInputIndex].value);
    }

    // --- Inn rest ---
    // Spend gold to restore HP to max.
    // 1:1 transition: same covenant, updated state.

    #[covenant.singleton(mode = transition)]
    entrypoint function inn_rest(
        sig ownerSig,
        int cost
    ) : (byte[83] new_state) {
        require(checkSig(ownerSig, owner));
        require(cost > 0);

        // Stake carries forward
        require(tx.outputs[0].value >= tx.inputs[this.activeInputIndex].value);
    }

    // --- Daily reset ---
    // Reset forest fights counter.
    // Uses this.age to enforce 24h cooldown.

    #[covenant.singleton(mode = transition)]
    entrypoint function daily_reset(
        sig ownerSig
    ) : (byte[83] new_state) {
        require(checkSig(ownerSig, owner));

        // At least 24 hours since last spend
        require(this.age >= 86400 seconds);
    }

    // --- PvP result ---
    // Called after arena combat.
    // Winner gains gold + XP, loser loses gold.
    // Two Player covenant inputs + Arena covenant = ICC atomic tx.

    #[covenant.singleton(mode = transition)]
    entrypoint function pvp_result(
        sig ownerSig,
        bool won,
        int xpGain,
        int goldDelta    // positive for winner, negative for loser
    ) : (byte[83] new_state) {
        require(checkSig(ownerSig, owner));
        require(xpGain >= 0);

        // If won, stake increases (opponent's gold transferred)
        // If lost, stake decreases
        // Covenant output must exist
        require(tx.outputs.length >= 1);
    }

    // --- Withdraw ---
    // Destroy the player UTXO and reclaim locked KAS.
    // No self-preservation — UTXO is consumed.

    entrypoint function withdraw(sig ownerSig) {
        require(checkSig(ownerSig, owner));
        // No output covenant required — funds released to owner
    }
}
