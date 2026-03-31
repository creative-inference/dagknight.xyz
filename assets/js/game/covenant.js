/* ============================================================
   DAGKnight BBS — Covenant Transaction Builder
   All tx submission via wRPC to our TN12 node.
   UTXO lookups via wRPC (getUtxosByAddresses).
   160-byte contract: single update entrypoint with checkSig +
   validateOutputState. Owner = raw x-only pubkey.
   ============================================================ */

const COVENANT_NODE_WS = 'wss://tn12.dagknight.xyz';
const FAUCET_PRIVATE_KEY = 'e2e890b7101ce497fbfdb97707d3ba3bd8c727b2fa9fae81be80d629ea7581fc';

// Compiled Player covenant (160 bytes, without_selector=true)
const PLAYER_SCRIPT_HEX = '20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa08140000000000000008000000000000000008010000000000000057795479876958795879ac69567900a269557900a269547978a269537901207c7e577958cd587c7e577958cd587c7e577958cd587c7e7e7e7eb976c97602a00094013c937cbc7eaa02000001aa7e01207e7c7e01877e00c3876975757575757575757551';

// Compiled Shop covenant (56 bytes, validates output 1)
// sell(payment:int) — no sig required, anyone can buy
// State: gold_collected (int64LE at hex offset 2-17)
const SHOP_SCRIPT_HEX = '0800000000000000007800a0697652799358cd587c7eb976c97601389459937cbc7eaa02000001aa7e01207e7c7e01877e51c38769757551';

// Compiled Opponent/NPC covenant (80 bytes, validates output 1)
// fight(newHp:int, newGold:int) — no sig, public NPC
// State: hp (int64LE at hex offset 2-17), gold (int64LE at hex offset 20-35)
const OPPONENT_SCRIPT_HEX = '083200000000000000086400000000000000537900a269527900a269537958cd587c7e537958cd587c7e7eb976c9760150940112937cbc7eaa02000001aa7e01207e7c7e01877e51c387697575757551';

function int64LE(n) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigInt64(0, BigInt(n), true);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const Covenant = {
  _rpc: null,
  _kaspa: null,

  // Lazy connect to our TN12 node
  async ensureRpc(kaspa) {
    if (this._rpc) return this._rpc;
    this._kaspa = kaspa;
    const rpc = new kaspa.RpcClient({ url: COVENANT_NODE_WS, encoding: kaspa.Encoding.SerdeJson });
    await rpc.connect();
    this._rpc = rpc;
    return rpc;
  },

  buildPlayerScript(pubkeyHex, hp, gold, level) {
    let s = PLAYER_SCRIPT_HEX.replaceAll('aa'.repeat(32), pubkeyHex);
    s = s.substring(0, 68) + int64LE(hp) + s.substring(84);
    s = s.substring(0, 86) + int64LE(gold) + s.substring(102);
    s = s.substring(0, 104) + int64LE(level) + s.substring(120);
    return s;
  },

  getCovenantAddress(kaspa, pubkeyHex, hp, gold, level) {
    const script = this.buildPlayerScript(pubkeyHex, hp, gold, level);
    const p2shSpk = kaspa.ScriptBuilder.fromScript(script).createPayToScriptHashScript();
    return kaspa.addressFromScriptPublicKey(p2shSpk, 'testnet-12')?.toString();
  },

  async getUtxos(address) {
    const rpc = this._rpc;
    if (!rpc) return [];
    const resp = await rpc.getUtxosByAddresses({ addresses: [address] });
    const entries = resp.entries || resp || [];
    // Normalize to REST-like format
    return entries.map(u => {
      const entry = u.entry || u.utxoEntry || u;
      return {
        outpoint: u.outpoint,
        utxoEntry: {
          amount: String(entry.amount),
          scriptPublicKey: entry.scriptPublicKey,
          blockDaaScore: String(entry.blockDaaScore || 0),
          isCoinbase: entry.isCoinbase || false,
        },
      };
    });
  },

  async findCovenantUtxo(address) {
    const utxos = await this.getUtxos(address);
    return utxos && utxos.length > 0 ? utxos[0] : null;
  },

  // Verify on-chain state matches what we expect
  async verifyOnChainState(kaspa, pubkeyHex, hp, gold, level) {
    const addr = this.getCovenantAddress(kaspa, pubkeyHex, hp, gold, level);
    if (!addr) return null;
    const utxo = await this.findCovenantUtxo(addr);
    if (utxo) return { hp, gold, level, utxo, address: addr };
    return null;
  },

  // --- Shop Covenant ---

  buildShopScript(goldCollected) {
    let s = SHOP_SCRIPT_HEX;
    s = s.substring(0, 2) + int64LE(goldCollected) + s.substring(18);
    return s;
  },

  getShopAddress(kaspa, goldCollected) {
    const script = this.buildShopScript(goldCollected);
    const spk = kaspa.ScriptBuilder.fromScript(script).createPayToScriptHashScript();
    return kaspa.addressFromScriptPublicKey(spk, 'testnet-12')?.toString();
  },

  // --- Opponent/NPC Covenant ---

  buildOpponentScript(hp, gold) {
    let s = OPPONENT_SCRIPT_HEX;
    s = s.substring(0, 2) + int64LE(hp) + s.substring(18);
    s = s.substring(0, 20) + int64LE(gold) + s.substring(36);
    return s;
  },

  getOpponentAddress(kaspa, hp, gold) {
    const script = this.buildOpponentScript(hp, gold);
    const spk = kaspa.ScriptBuilder.fromScript(script).createPayToScriptHashScript();
    return kaspa.addressFromScriptPublicKey(spk, 'testnet-12')?.toString();
  },

  // ICC PvP: Player + Opponent covenants in one atomic tx
  // Input 0: Player (validates output 0), Input 1: Opponent (validates output 1)
  async pvpFight(kaspa, privateKey, pubkeyHex,
    curHp, curGold, curLevel,
    newPlayerHp, newPlayerGold,
    oppHp, oppGold,
    newOppHp, newOppGold,
    playerUtxo, oppUtxo
  ) {
    const playerScript = this.buildPlayerScript(pubkeyHex, curHp, curGold, curLevel);
    const newPlayerScript = this.buildPlayerScript(pubkeyHex, newPlayerHp, newPlayerGold, curLevel);
    const oppScript = this.buildOpponentScript(oppHp, oppGold);
    const newOppScript = this.buildOpponentScript(newOppHp, newOppGold);

    const playerSpk = kaspa.ScriptBuilder.fromScript(playerScript).createPayToScriptHashScript();
    const newPlayerSpk = kaspa.ScriptBuilder.fromScript(newPlayerScript).createPayToScriptHashScript();
    const oppSpk = kaspa.ScriptBuilder.fromScript(oppScript).createPayToScriptHashScript();
    const newOppSpk = kaspa.ScriptBuilder.fromScript(newOppScript).createPayToScriptHashScript();

    const pAmt = BigInt(playerUtxo.utxoEntry.amount);
    const oAmt = BigInt(oppUtxo.utxoEntry.amount);
    const fee = 10000n + BigInt(Math.floor(Math.random() * 1000));

    // Unsigned tx for player signing
    const unsignedTx = new kaspa.Transaction({
      version: 0,
      inputs: [
        {
          previousOutpoint: playerUtxo.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
          utxo: { outpoint: playerUtxo.outpoint, amount: pAmt, scriptPublicKey: playerSpk, blockDaaScore: BigInt(playerUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false },
        },
        {
          previousOutpoint: oppUtxo.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 0,
          utxo: { outpoint: oppUtxo.outpoint, amount: oAmt, scriptPublicKey: oppSpk, blockDaaScore: BigInt(oppUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false },
        },
      ],
      outputs: [
        { value: pAmt - fee, scriptPublicKey: newPlayerSpk },
        { value: oAmt, scriptPublicKey: newOppSpk },
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    // Player sig_script (input 0): <sig> <pubkey> <newHp> <newGold> <newLevel> <redeem>
    const sigHex = kaspa.createInputSignature(unsignedTx, 0, privateKey);
    const pubBytes = new Uint8Array(pubkeyHex.match(/.{2}/g).map(h => parseInt(h, 16)));
    const playerArgSb = new kaspa.ScriptBuilder();
    playerArgSb.addData(pubBytes);
    playerArgSb.addI64(BigInt(newPlayerHp));
    playerArgSb.addI64(BigInt(newPlayerGold));
    playerArgSb.addI64(BigInt(curLevel));
    const playerRedeemSb = new kaspa.ScriptBuilder();
    playerRedeemSb.addData(new Uint8Array(playerScript.match(/.{2}/g).map(h => parseInt(h, 16))));
    const playerSigScript = sigHex + playerArgSb.toString() + playerRedeemSb.toString();

    // Opponent sig_script (input 1): <newHp> <newGold> <redeem>
    const oppArgSb = new kaspa.ScriptBuilder();
    oppArgSb.addI64(BigInt(newOppHp));
    oppArgSb.addI64(BigInt(newOppGold));
    const oppRedeemSb = new kaspa.ScriptBuilder();
    oppRedeemSb.addData(new Uint8Array(oppScript.match(/.{2}/g).map(h => parseInt(h, 16))));
    const oppSigScript = oppArgSb.toString() + oppRedeemSb.toString();

    const signedTx = new kaspa.Transaction({
      version: 0,
      inputs: [
        { previousOutpoint: playerUtxo.outpoint, signatureScript: playerSigScript, sequence: 0n, sigOpCount: 1 },
        { previousOutpoint: oppUtxo.outpoint, signatureScript: oppSigScript, sequence: 0n, sigOpCount: 0 },
      ],
      outputs: [
        { value: pAmt - fee, scriptPublicKey: newPlayerSpk },
        { value: oAmt, scriptPublicKey: newOppSpk },
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const rpc = await this.ensureRpc(kaspa);
    const rpcResult = await rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
    return { transactionId: rpcResult.transactionId, playerOutputAmount: String(pAmt - fee) };
  },

  // Deploy shop covenant UTXO
  async createShopUtxo(kaspa, privateKey, goldCollected, fundingUtxos) {
    const script = this.buildShopScript(goldCollected);
    const shopSpk = kaspa.ScriptBuilder.fromScript(script).createPayToScriptHashScript();
    const playerSpk = kaspa.payToAddressScript(privateKey.toAddress('testnet-12'));

    const inputs = fundingUtxos.filter(u => BigInt(u.utxoEntry?.amount || 0) > 0n).map(u => {
      const outpoint = { transactionId: u.outpoint.transactionId, index: u.outpoint.index };
      return {
        previousOutpoint: outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
        utxo: { outpoint, amount: BigInt(u.utxoEntry.amount), scriptPublicKey: playerSpk, blockDaaScore: BigInt(u.utxoEntry.blockDaaScore || 0), isCoinbase: false },
      };
    });

    let totalInput = 0n;
    for (const inp of inputs) totalInput += inp.utxo.amount;
    const shopValue = 20000000n;
    const fee = 500000n;
    if (totalInput < shopValue + fee) throw new Error('Insufficient funds for shop');
    const change = totalInput - shopValue - fee;

    const outputs = [{ value: shopValue, scriptPublicKey: shopSpk }];
    if (change > 0n) outputs.push({ value: change, scriptPublicKey: playerSpk });

    const tx = new kaspa.Transaction({
      version: 0, inputs, outputs,
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const signedTx = kaspa.signTransaction(tx, [privateKey], false);
    const rpc = await this.ensureRpc(kaspa);
    return rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
  },

  // Deploy Player + Shop + Opponent covenants in a single transaction
  async createPlayerAndShop(kaspa, privateKey, pubkeyHex, hp, gold, level, fundingUtxos) {
    const playerScript = this.buildPlayerScript(pubkeyHex, hp, gold, level);
    const playerSpk = kaspa.ScriptBuilder.fromScript(playerScript).createPayToScriptHashScript();
    const shopScript = this.buildShopScript(0);
    const shopSpk = kaspa.ScriptBuilder.fromScript(shopScript).createPayToScriptHashScript();
    const oppScript = this.buildOpponentScript(50, 100);
    const oppSpk = kaspa.ScriptBuilder.fromScript(oppScript).createPayToScriptHashScript();
    const changeSpk = kaspa.payToAddressScript(privateKey.toAddress('testnet-12'));

    const inputs = fundingUtxos.filter(u => BigInt(u.utxoEntry?.amount || 0) > 0n).map(u => {
      const outpoint = { transactionId: u.outpoint.transactionId, index: u.outpoint.index };
      return {
        previousOutpoint: outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
        utxo: { outpoint, amount: BigInt(u.utxoEntry.amount), scriptPublicKey: changeSpk, blockDaaScore: BigInt(u.utxoEntry.blockDaaScore || 0), isCoinbase: false },
      };
    });

    let totalInput = 0n;
    for (const inp of inputs) totalInput += inp.utxo.amount;
    const playerValue = 20000000n;  // 0.2 KAS each — storage mass ~200k, under 500k limit
    const shopValue = 20000000n;
    const oppValue = 20000000n;
    const fee = 500000n;
    if (totalInput < playerValue + shopValue + oppValue + fee) throw new Error('Insufficient funds');
    const change = totalInput - playerValue - shopValue - oppValue - fee;

    const outputs = [
      { value: playerValue, scriptPublicKey: playerSpk },
      { value: shopValue, scriptPublicKey: shopSpk },
      { value: oppValue, scriptPublicKey: oppSpk },
    ];
    if (change > 0n) outputs.push({ value: change, scriptPublicKey: changeSpk });

    const tx = new kaspa.Transaction({
      version: 0, inputs, outputs,
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const signedTx = kaspa.signTransaction(tx, [privateKey], false);
    const rpc = await this.ensureRpc(kaspa);
    return rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
  },

  // Deploy covenants directly from faucet coinbase UTXO (no intermediate wallet funding)
  async createFromFaucet(kaspa, playerPrivateKey, pubkeyHex, hp, gold, level) {
    const rpc = await this.ensureRpc(kaspa);
    const faucetPk = new kaspa.PrivateKey(FAUCET_PRIVATE_KEY);
    const faucetAddr = faucetPk.toAddress('testnet-12');
    const faucetSpk = kaspa.payToAddressScript(faucetAddr);
    const playerAddr = playerPrivateKey.toAddress('testnet-12');
    const playerSpk = kaspa.payToAddressScript(playerAddr);

    // Prefer non-coinbase UTXOs (lower storage mass), fall back to mature coinbase
    const resp = await rpc.getUtxosByAddresses({ addresses: [faucetAddr.toString()] });
    const allUtxos = resp.entries || resp || [];
    const info = await rpc.getBlockDagInfo();
    const daa = Number(info.virtualDaaScore);
    const nonCoinbase = allUtxos.filter(u => !(u.entry || u).isCoinbase && BigInt((u.entry || u).amount) >= 200000000n);
    const mature = allUtxos.filter(u => (daa - Number((u.entry || u).blockDaaScore)) > 1100);
    const candidates = nonCoinbase.length ? nonCoinbase : mature;
    if (!candidates.length) throw new Error('No spendable faucet UTXOs');

    const u = candidates[0];
    const e = u.entry || u;
    const inputAmt = BigInt(e.amount);

    // Build covenant outputs
    const covPlayerSpk = kaspa.ScriptBuilder.fromScript(this.buildPlayerScript(pubkeyHex, hp, gold, level)).createPayToScriptHashScript();
    const covShopSpk = kaspa.ScriptBuilder.fromScript(this.buildShopScript(0)).createPayToScriptHashScript();
    const covOppSpk = kaspa.ScriptBuilder.fromScript(this.buildOpponentScript(50, 100)).createPayToScriptHashScript();

    const playerValue = 20000000n;  // 0.2 KAS each — storage mass ~200k, under 500k limit
    const shopValue = 20000000n;
    const oppValue = 20000000n;
    const walletValue = 20000000n; // 0.2 KAS to player wallet
    const fee = 500000n;
    const total = playerValue + shopValue + oppValue + walletValue + fee;
    if (inputAmt < total) throw new Error('Faucet UTXO too small');
    const change = inputAmt - total;

    const outputs = [
      { value: playerValue, scriptPublicKey: covPlayerSpk },
      { value: shopValue, scriptPublicKey: covShopSpk },
      { value: oppValue, scriptPublicKey: covOppSpk },
      { value: walletValue, scriptPublicKey: playerSpk },
    ];
    if (change > 0n) outputs.push({ value: change, scriptPublicKey: faucetSpk });

    const tx = new kaspa.Transaction({
      version: 0,
      inputs: [{
        previousOutpoint: u.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
        utxo: { outpoint: u.outpoint, amount: inputAmt, scriptPublicKey: faucetSpk, blockDaaScore: BigInt(e.blockDaaScore || 0), isCoinbase: e.isCoinbase || false },
      }],
      outputs,
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const signedTx = kaspa.signTransaction(tx, [faucetPk], false);
    return rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
  },

  // ICC: Player buys from Shop — atomic tx with both covenants
  // Input 0: Player covenant, Input 1: Shop covenant
  // Output 0: New Player (gold decreased), Output 1: New Shop (gold_collected increased)
  async purchaseFromShop(kaspa, privateKey, pubkeyHex,
    curHp, curGold, curLevel,
    newGold, payment,
    playerUtxo, shopUtxo, shopGoldCollected
  ) {
    const playerScript = this.buildPlayerScript(pubkeyHex, curHp, curGold, curLevel);
    const newPlayerScript = this.buildPlayerScript(pubkeyHex, curHp, newGold, curLevel);
    const shopScript = this.buildShopScript(shopGoldCollected);
    const newShopScript = this.buildShopScript(shopGoldCollected + payment);

    const playerSpk = kaspa.ScriptBuilder.fromScript(playerScript).createPayToScriptHashScript();
    const newPlayerSpk = kaspa.ScriptBuilder.fromScript(newPlayerScript).createPayToScriptHashScript();
    const shopSpk = kaspa.ScriptBuilder.fromScript(shopScript).createPayToScriptHashScript();
    const newShopSpk = kaspa.ScriptBuilder.fromScript(newShopScript).createPayToScriptHashScript();

    const pAmt = BigInt(playerUtxo.utxoEntry.amount);
    const sAmt = BigInt(shopUtxo.utxoEntry.amount);
    const fee = 10000n + BigInt(Math.floor(Math.random() * 1000));

    // Unsigned tx for signing (player input needs sig)
    const unsignedTx = new kaspa.Transaction({
      version: 0,
      inputs: [
        {
          previousOutpoint: playerUtxo.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
          utxo: { outpoint: playerUtxo.outpoint, amount: pAmt, scriptPublicKey: playerSpk, blockDaaScore: BigInt(playerUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false },
        },
        {
          previousOutpoint: shopUtxo.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 0,
          utxo: { outpoint: shopUtxo.outpoint, amount: sAmt, scriptPublicKey: shopSpk, blockDaaScore: BigInt(shopUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false },
        },
      ],
      outputs: [
        { value: pAmt - fee, scriptPublicKey: newPlayerSpk },
        { value: sAmt, scriptPublicKey: newShopSpk },
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    // Sign player input (input 0)
    const sigHex = kaspa.createInputSignature(unsignedTx, 0, privateKey);

    // Player sig_script: <sig> <pubkey> <newHp> <newGold> <newLevel> <redeem>
    const pubBytes = new Uint8Array(pubkeyHex.match(/.{2}/g).map(h => parseInt(h, 16)));
    const playerArgSb = new kaspa.ScriptBuilder();
    playerArgSb.addData(pubBytes);
    playerArgSb.addI64(BigInt(curHp));
    playerArgSb.addI64(BigInt(newGold));
    playerArgSb.addI64(BigInt(curLevel));
    const playerRedeemSb = new kaspa.ScriptBuilder();
    playerRedeemSb.addData(new Uint8Array(playerScript.match(/.{2}/g).map(h => parseInt(h, 16))));
    const playerSigScript = sigHex + playerArgSb.toString() + playerRedeemSb.toString();

    // Shop sig_script: <payment> <redeem>
    const shopArgSb = new kaspa.ScriptBuilder();
    shopArgSb.addI64(BigInt(payment));
    const shopRedeemSb = new kaspa.ScriptBuilder();
    shopRedeemSb.addData(new Uint8Array(shopScript.match(/.{2}/g).map(h => parseInt(h, 16))));
    const shopSigScript = shopArgSb.toString() + shopRedeemSb.toString();

    // Rebuild with sig_scripts
    const signedTx = new kaspa.Transaction({
      version: 0,
      inputs: [
        { previousOutpoint: playerUtxo.outpoint, signatureScript: playerSigScript, sequence: 0n, sigOpCount: 1 },
        { previousOutpoint: shopUtxo.outpoint, signatureScript: shopSigScript, sequence: 0n, sigOpCount: 0 },
      ],
      outputs: [
        { value: pAmt - fee, scriptPublicKey: newPlayerSpk },
        { value: sAmt, scriptPublicKey: newShopSpk },
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const rpc = await this.ensureRpc(kaspa);
    return rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
  },

  // Decode state from a P2SH script hex (reverse of buildPlayerScript)
  decodePlayerState(scriptHex) {
    if (!scriptHex || scriptHex.length < 120) return null;
    // owner at hex[2..65], hp at hex[68..83], gold at hex[86..101], level at hex[104..119]
    const owner = scriptHex.substring(2, 66);
    const hpHex = scriptHex.substring(68, 84);
    const goldHex = scriptHex.substring(86, 102);
    const levelHex = scriptHex.substring(104, 120);
    const readLE = hex => {
      const bytes = hex.match(/.{2}/g).map(h => parseInt(h, 16));
      let val = 0n;
      for (let i = 7; i >= 0; i--) val = (val << 8n) | BigInt(bytes[i]);
      return Number(val);
    };
    return { owner, hp: readLE(hpHex), gold: readLE(goldHex), level: readLE(levelHex) };
  },

  // Deploy: create the initial Player covenant UTXO
  async createPlayerUtxo(kaspa, privateKey, pubkeyHex, hp, gold, level, fundingUtxos) {
    const script = this.buildPlayerScript(pubkeyHex, hp, gold, level);
    const covenantSpk = kaspa.ScriptBuilder.fromScript(script).createPayToScriptHashScript();
    const playerSpk = kaspa.payToAddressScript(privateKey.toAddress('testnet-12'));

    const inputs = fundingUtxos.filter(u => BigInt(u.utxoEntry?.amount || 0) > 0n).map(u => {
      const outpoint = { transactionId: u.outpoint.transactionId, index: u.outpoint.index };
      return {
        previousOutpoint: outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
        utxo: {
          outpoint, amount: BigInt(u.utxoEntry.amount), scriptPublicKey: playerSpk,
          blockDaaScore: BigInt(u.utxoEntry.blockDaaScore || 0), isCoinbase: false,
        },
      };
    });

    let totalInput = 0n;
    for (const inp of inputs) totalInput += inp.utxo.amount;
    const covenantValue = 10000000n;
    const fee = 500000n;
    if (totalInput < covenantValue + fee) throw new Error('Insufficient funds');
    const change = totalInput - covenantValue - fee;

    const outputs = [{ value: covenantValue, scriptPublicKey: covenantSpk }];
    if (change > 0n) outputs.push({ value: change, scriptPublicKey: playerSpk });

    const tx = new kaspa.Transaction({
      version: 0, inputs, outputs,
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const signedTx = kaspa.signTransaction(tx, [privateKey], false);
    const rpc = await this.ensureRpc(kaspa);
    return rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
  },

  // Update: spend covenant → recreate with new state
  async updatePlayerUtxo(kaspa, privateKey, pubkeyHex,
    curHp, curGold, curLevel,
    newHp, newGold, newLevel,
    covenantUtxo
  ) {
    const currentScript = this.buildPlayerScript(pubkeyHex, curHp, curGold, curLevel);
    const newScript = this.buildPlayerScript(pubkeyHex, newHp, newGold, newLevel);
    const newSpk = kaspa.ScriptBuilder.fromScript(newScript).createPayToScriptHashScript();
    const currentSpk = kaspa.ScriptBuilder.fromScript(currentScript).createPayToScriptHashScript();

    const covenantValue = BigInt(covenantUtxo.utxoEntry.amount);
    const fee = 10000n + BigInt(Math.floor(Math.random() * 1000));
    const outpoint = { transactionId: covenantUtxo.outpoint.transactionId, index: covenantUtxo.outpoint.index };

    const unsignedTx = new kaspa.Transaction({
      version: 0,
      inputs: [{
        previousOutpoint: outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
        utxo: {
          outpoint, amount: covenantValue, scriptPublicKey: currentSpk,
          blockDaaScore: BigInt(covenantUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false,
        },
      }],
      outputs: [{ value: covenantValue - fee, scriptPublicKey: newSpk }],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const sigHex = kaspa.createInputSignature(unsignedTx, 0, privateKey);

    const pubBytes = new Uint8Array(pubkeyHex.match(/.{2}/g).map(h => parseInt(h, 16)));
    const argSb = new kaspa.ScriptBuilder();
    argSb.addData(pubBytes);
    argSb.addI64(BigInt(newHp));
    argSb.addI64(BigInt(newGold));
    argSb.addI64(BigInt(newLevel));

    const redeemSb = new kaspa.ScriptBuilder();
    redeemSb.addData(new Uint8Array(currentScript.match(/.{2}/g).map(h => parseInt(h, 16))));
    const sigScript = sigHex + argSb.toString() + redeemSb.toString();

    const outputAmount = covenantValue - fee;
    const signedTx = new kaspa.Transaction({
      version: 0,
      inputs: [{
        previousOutpoint: outpoint, signatureScript: sigScript, sequence: 0n, sigOpCount: 1,
      }],
      outputs: [{ value: outputAmount, scriptPublicKey: newSpk }],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const rpc = await this.ensureRpc(kaspa);
    const rpcResult = await rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
    return { transactionId: rpcResult.transactionId, playerOutputAmount: String(outputAmount) };
  },

  // Retire: spend Player covenant, send KAS back to wallet
  // Output 0 = minimal covenant (satisfies validateOutputState), Output 1 = wallet
  async retirePlayer(kaspa, privateKey, pubkeyHex, curHp, curGold, curLevel, covenantUtxo) {
    const currentScript = this.buildPlayerScript(pubkeyHex, curHp, curGold, curLevel);
    const newScript = this.buildPlayerScript(pubkeyHex, curHp, curGold, curLevel);
    const newSpk = kaspa.ScriptBuilder.fromScript(newScript).createPayToScriptHashScript();
    const currentSpk = kaspa.ScriptBuilder.fromScript(currentScript).createPayToScriptHashScript();
    const walletSpk = kaspa.payToAddressScript(privateKey.toAddress('testnet-12'));

    const covenantValue = BigInt(covenantUtxo.utxoEntry.amount);
    const fee = 10000n;
    const minCovValue = 5000000n; // 0.05 KAS — small but above dust threshold // keep 0.2 KAS in covenant to avoid storage mass spike
    const withdrawAmount = covenantValue - minCovValue - fee;
    if (withdrawAmount <= 0n) return null; // nothing to withdraw

    const outpoint = { transactionId: covenantUtxo.outpoint.transactionId, index: covenantUtxo.outpoint.index };

    const unsignedTx = new kaspa.Transaction({
      version: 0,
      inputs: [{
        previousOutpoint: outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
        utxo: { outpoint, amount: covenantValue, scriptPublicKey: currentSpk, blockDaaScore: BigInt(covenantUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false },
      }],
      outputs: [
        { value: minCovValue, scriptPublicKey: newSpk },       // output 0: covenant (validated)
        { value: withdrawAmount, scriptPublicKey: walletSpk }, // output 1: wallet (extra, unchecked)
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const sigHex = kaspa.createInputSignature(unsignedTx, 0, privateKey);
    const pubBytes = new Uint8Array(pubkeyHex.match(/.{2}/g).map(h => parseInt(h, 16)));
    const argSb = new kaspa.ScriptBuilder();
    argSb.addData(pubBytes);
    argSb.addI64(BigInt(curHp)); argSb.addI64(BigInt(curGold)); argSb.addI64(BigInt(curLevel));
    const redeemSb = new kaspa.ScriptBuilder();
    redeemSb.addData(new Uint8Array(currentScript.match(/.{2}/g).map(h => parseInt(h, 16))));
    const sigScript = sigHex + argSb.toString() + redeemSb.toString();

    const signedTx = new kaspa.Transaction({
      version: 0,
      inputs: [{ previousOutpoint: outpoint, signatureScript: sigScript, sequence: 0n, sigOpCount: 1 }],
      outputs: [
        { value: minCovValue, scriptPublicKey: newSpk },
        { value: withdrawAmount, scriptPublicKey: walletSpk },
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const rpc = await this.ensureRpc(kaspa);
    const rpcResult = await rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
    return { transactionId: rpcResult.transactionId, withdrawAmount: String(withdrawAmount) };
  },

  // Retire: spend Shop covenant, send KAS to wallet
  // Output 0 = wallet, Output 1 = minimal covenant (satisfies shop's validate on output 1)
  async retireShop(kaspa, goldCollected, shopUtxo, walletAddress) {
    const currentScript = this.buildShopScript(goldCollected);
    const newScript = this.buildShopScript(goldCollected + 1); // payment=1 to pass shop's payment>0 check
    const newSpk = kaspa.ScriptBuilder.fromScript(newScript).createPayToScriptHashScript();
    const currentSpk = kaspa.ScriptBuilder.fromScript(currentScript).createPayToScriptHashScript();
    const walletSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress));

    const shopValue = BigInt(shopUtxo.utxoEntry.amount);
    const fee = 10000n;
    const minCovValue = 5000000n; // 0.05 KAS — small but above dust threshold
    const withdrawAmount = shopValue - minCovValue - fee;
    if (withdrawAmount <= 0n) return null;

    const outpoint = { transactionId: shopUtxo.outpoint.transactionId, index: shopUtxo.outpoint.index };

    // Shop validates output 1 — sig_script: <payment=1> <redeem> (payment must be > 0)
    const argSb = new kaspa.ScriptBuilder();
    argSb.addI64(1n);
    const redeemSb = new kaspa.ScriptBuilder();
    redeemSb.addData(new Uint8Array(currentScript.match(/.{2}/g).map(h => parseInt(h, 16))));
    const sigScript = argSb.toString() + redeemSb.toString();

    const signedTx = new kaspa.Transaction({
      version: 0,
      inputs: [{ previousOutpoint: outpoint, signatureScript: sigScript, sequence: 0n, sigOpCount: 0 }],
      outputs: [
        { value: withdrawAmount, scriptPublicKey: walletSpk },  // output 0: wallet
        { value: minCovValue, scriptPublicKey: newSpk },        // output 1: covenant (validated)
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const rpc = await this.ensureRpc(kaspa);
    const rpcResult = await rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
    return { transactionId: rpcResult.transactionId, withdrawAmount: String(withdrawAmount) };
  },

  // Retire: spend Opponent covenant, send KAS to wallet
  // Output 0 = wallet, Output 1 = minimal covenant (validates output 1)
  async retireOpponent(kaspa, oppHp, oppGold, oppUtxo, walletAddress) {
    const currentScript = this.buildOpponentScript(oppHp, oppGold);
    const newScript = this.buildOpponentScript(oppHp, oppGold);
    const newSpk = kaspa.ScriptBuilder.fromScript(newScript).createPayToScriptHashScript();
    const currentSpk = kaspa.ScriptBuilder.fromScript(currentScript).createPayToScriptHashScript();
    const walletSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress));

    const oppValue = BigInt(oppUtxo.utxoEntry.amount);
    const fee = 10000n;
    const minCovValue = 5000000n; // 0.05 KAS — small but above dust threshold
    const withdrawAmount = oppValue - minCovValue - fee;
    if (withdrawAmount <= 0n) return null;

    const outpoint = { transactionId: oppUtxo.outpoint.transactionId, index: oppUtxo.outpoint.index };

    // Opponent validates output 1 — sig_script: <newHp> <newGold> <redeem>
    const argSb = new kaspa.ScriptBuilder();
    argSb.addI64(BigInt(oppHp)); argSb.addI64(BigInt(oppGold));
    const redeemSb = new kaspa.ScriptBuilder();
    redeemSb.addData(new Uint8Array(currentScript.match(/.{2}/g).map(h => parseInt(h, 16))));
    const sigScript = argSb.toString() + redeemSb.toString();

    const signedTx = new kaspa.Transaction({
      version: 0,
      inputs: [{ previousOutpoint: outpoint, signatureScript: sigScript, sequence: 0n, sigOpCount: 0 }],
      outputs: [
        { value: withdrawAmount, scriptPublicKey: walletSpk },  // output 0: wallet
        { value: minCovValue, scriptPublicKey: newSpk },        // output 1: covenant (validated)
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const rpc = await this.ensureRpc(kaspa);
    const rpcResult = await rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
    return { transactionId: rpcResult.transactionId, withdrawAmount: String(withdrawAmount) };
  },
};
