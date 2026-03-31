/* ============================================================
   DAGKnight BBS — Covenant Transaction Builder (KWP-ONLY)
   No manual hex fallback. Requires KWP_WORLD to be loaded.
   State encoding/decoding via Kaspa World Protocol standards.
   Transaction building via KWP-6 patterns.
   ============================================================ */

const COVENANT_NODE_WS = 'wss://tn12.dagknight.xyz';
const FAUCET_PRIVATE_KEY = 'e2e890b7101ce497fbfdb97707d3ba3bd8c727b2fa9fae81be80d629ea7581fc';

// Script hex templates (state placeholders, logic is constant)
const PLAYER_SCRIPT_HEX = '20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa08140000000000000008000000000000000008010000000000000057795479876958795879ac69567900a269557900a269547978a269537901207c7e577958cd587c7e577958cd587c7e577958cd587c7e7e7e7eb976c97602a00094013c937cbc7eaa02000001aa7e01207e7c7e01877e00c3876975757575757575757551';
const SHOP_SCRIPT_HEX = '0800000000000000007800a0697652799358cd587c7eb976c97601389459937cbc7eaa02000001aa7e01207e7c7e01877e51c38769757551';
const OPPONENT_SCRIPT_HEX = '083200000000000000086400000000000000537900a269527900a269537958cd587c7e537958cd587c7e7eb976c9760150940112937cbc7eaa02000001aa7e01207e7c7e01877e51c387697575757551';

function _world() {
  if (!window.KWP_WORLD) throw new Error('[KWP] Schema not loaded — cannot proceed');
  return window.KWP_WORLD;
}

function _scriptToSpk(kaspa, scriptHex) {
  return kaspa.ScriptBuilder.fromScript(scriptHex).createPayToScriptHashScript();
}

function _buildRedeem(kaspa, scriptHex) {
  const sb = new kaspa.ScriptBuilder();
  sb.addData(new Uint8Array(scriptHex.match(/.{2}/g).map(h => parseInt(h, 16))));
  return sb.toString();
}

function _buildSignedArgs(kaspa, pubkeyHex, values) {
  const pubBytes = new Uint8Array(pubkeyHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const sb = new kaspa.ScriptBuilder();
  sb.addData(pubBytes);
  for (const v of values) sb.addI64(BigInt(v));
  return sb.toString();
}

function _buildPublicArgs(kaspa, values) {
  const sb = new kaspa.ScriptBuilder();
  for (const v of values) sb.addI64(BigInt(v));
  return sb.toString();
}

function _jitteredFee() {
  return 10000n + BigInt(Math.floor(Math.random() * 1000));
}

const Covenant = {
  _rpc: null,
  _kaspa: null,

  async ensureRpc(kaspa) {
    if (this._rpc) return this._rpc;
    this._kaspa = kaspa;
    const rpc = new kaspa.RpcClient({ url: COVENANT_NODE_WS, encoding: kaspa.Encoding.SerdeJson });
    await rpc.connect();
    this._rpc = rpc;
    return rpc;
  },

  // --- KWP-powered script building (no fallback) ---

  buildPlayerScript(pubkeyHex, hp, gold, level) {
    return _world().encodeToScriptHex('player', PLAYER_SCRIPT_HEX, {
      owner: pubkeyHex, hp: BigInt(hp), gold: BigInt(gold), level: BigInt(level),
    });
  },

  buildShopScript(goldCollected) {
    return _world().encodeToScriptHex('shop', SHOP_SCRIPT_HEX, {
      gold_collected: BigInt(goldCollected),
    });
  },

  buildOpponentScript(hp, gold) {
    return _world().encodeToScriptHex('opponent', OPPONENT_SCRIPT_HEX, {
      hp: BigInt(hp), gold: BigInt(gold),
    });
  },

  // --- KWP-powered state decoding (no fallback) ---

  decodePlayerState(scriptHex) {
    if (!scriptHex || scriptHex.length < 120) return null;
    const s = _world().decodeFromScriptHex('player', scriptHex);
    return { owner: s.owner, hp: Number(s.hp), gold: Number(s.gold), level: Number(s.level) };
  },

  // --- KWP-powered entity identification ---

  identifyUtxo(scriptHex) {
    return _world().identifyEntity(scriptHex);
  },

  validateTransition(entityId, newState, prevState) {
    return _world().validate(entityId, newState, prevState);
  },

  // --- Address derivation (uses KWP encode + kaspa P2SH) ---

  getCovenantAddress(kaspa, pubkeyHex, hp, gold, level) {
    const script = this.buildPlayerScript(pubkeyHex, hp, gold, level);
    return kaspa.addressFromScriptPublicKey(_scriptToSpk(kaspa, script), 'testnet-12')?.toString();
  },

  getShopAddress(kaspa, goldCollected) {
    const script = this.buildShopScript(goldCollected);
    return kaspa.addressFromScriptPublicKey(_scriptToSpk(kaspa, script), 'testnet-12')?.toString();
  },

  getOpponentAddress(kaspa, hp, gold) {
    const script = this.buildOpponentScript(hp, gold);
    return kaspa.addressFromScriptPublicKey(_scriptToSpk(kaspa, script), 'testnet-12')?.toString();
  },

  // --- UTXO queries ---

  async getUtxos(address) {
    const rpc = this._rpc;
    if (!rpc) return [];
    const resp = await rpc.getUtxosByAddresses({ addresses: [address] });
    const entries = resp.entries || resp || [];
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

  async verifyOnChainState(kaspa, pubkeyHex, hp, gold, level) {
    const addr = this.getCovenantAddress(kaspa, pubkeyHex, hp, gold, level);
    if (!addr) return null;
    const utxo = await this.findCovenantUtxo(addr);
    if (utxo) return { hp, gold, level, utxo, address: addr };
    return null;
  },

  // --- KWP-6 Transaction Patterns ---

  // Self-transition: single entity update
  async updatePlayerUtxo(kaspa, privateKey, pubkeyHex,
    curHp, curGold, curLevel,
    newHp, newGold, newLevel,
    covenantUtxo
  ) {
    const currentScript = this.buildPlayerScript(pubkeyHex, curHp, curGold, curLevel);
    const newScript = this.buildPlayerScript(pubkeyHex, newHp, newGold, newLevel);
    const currentSpk = _scriptToSpk(kaspa, currentScript);
    const newSpk = _scriptToSpk(kaspa, newScript);

    const amount = BigInt(covenantUtxo.utxoEntry.amount);
    const fee = _jitteredFee();
    const outputAmount = amount - fee;
    const outpoint = { transactionId: covenantUtxo.outpoint.transactionId, index: covenantUtxo.outpoint.index };

    const unsignedTx = new kaspa.Transaction({
      version: 0,
      inputs: [{
        previousOutpoint: outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
        utxo: { outpoint, amount, scriptPublicKey: currentSpk, blockDaaScore: BigInt(covenantUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false },
      }],
      outputs: [{ value: outputAmount, scriptPublicKey: newSpk }],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const sigHex = kaspa.createInputSignature(unsignedTx, 0, privateKey);
    const args = _buildSignedArgs(kaspa, pubkeyHex, [newHp, newGold, newLevel]);
    const redeem = _buildRedeem(kaspa, currentScript);
    const sigScript = sigHex + args + redeem;

    const signedTx = new kaspa.Transaction({
      version: 0,
      inputs: [{ previousOutpoint: outpoint, signatureScript: sigScript, sequence: 0n, sigOpCount: 1 }],
      outputs: [{ value: outputAmount, scriptPublicKey: newSpk }],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const rpc = await this.ensureRpc(kaspa);
    const rpcResult = await rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
    return { transactionId: rpcResult.transactionId, playerOutputAmount: String(outputAmount) };
  },

  // ICC: Player + Opponent (PvE combat)
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

    const playerSpk = _scriptToSpk(kaspa, playerScript);
    const newPlayerSpk = _scriptToSpk(kaspa, newPlayerScript);
    const oppSpk = _scriptToSpk(kaspa, oppScript);
    const newOppSpk = _scriptToSpk(kaspa, newOppScript);

    const pAmt = BigInt(playerUtxo.utxoEntry.amount);
    const oAmt = BigInt(oppUtxo.utxoEntry.amount);
    const fee = _jitteredFee();

    const unsignedTx = new kaspa.Transaction({
      version: 0,
      inputs: [
        { previousOutpoint: playerUtxo.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
          utxo: { outpoint: playerUtxo.outpoint, amount: pAmt, scriptPublicKey: playerSpk, blockDaaScore: BigInt(playerUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false } },
        { previousOutpoint: oppUtxo.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 0,
          utxo: { outpoint: oppUtxo.outpoint, amount: oAmt, scriptPublicKey: oppSpk, blockDaaScore: BigInt(oppUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false } },
      ],
      outputs: [
        { value: pAmt - fee, scriptPublicKey: newPlayerSpk },
        { value: oAmt, scriptPublicKey: newOppSpk },
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const sigHex = kaspa.createInputSignature(unsignedTx, 0, privateKey);
    const playerArgs = _buildSignedArgs(kaspa, pubkeyHex, [newPlayerHp, newPlayerGold, curLevel]);
    const playerRedeem = _buildRedeem(kaspa, playerScript);
    const playerSigScript = sigHex + playerArgs + playerRedeem;

    const oppArgs = _buildPublicArgs(kaspa, [newOppHp, newOppGold]);
    const oppRedeem = _buildRedeem(kaspa, oppScript);
    const oppSigScript = oppArgs + oppRedeem;

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

  // ICC: Player + Shop (purchase)
  async purchaseFromShop(kaspa, privateKey, pubkeyHex,
    curHp, curGold, curLevel,
    newGold, payment,
    playerUtxo, shopUtxo, shopGoldCollected
  ) {
    const playerScript = this.buildPlayerScript(pubkeyHex, curHp, curGold, curLevel);
    const newPlayerScript = this.buildPlayerScript(pubkeyHex, curHp, newGold, curLevel);
    const shopScript = this.buildShopScript(shopGoldCollected);
    const newShopScript = this.buildShopScript(shopGoldCollected + payment);

    const playerSpk = _scriptToSpk(kaspa, playerScript);
    const newPlayerSpk = _scriptToSpk(kaspa, newPlayerScript);
    const shopSpk = _scriptToSpk(kaspa, shopScript);
    const newShopSpk = _scriptToSpk(kaspa, newShopScript);

    const pAmt = BigInt(playerUtxo.utxoEntry.amount);
    const sAmt = BigInt(shopUtxo.utxoEntry.amount);
    const fee = _jitteredFee();

    const unsignedTx = new kaspa.Transaction({
      version: 0,
      inputs: [
        { previousOutpoint: playerUtxo.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
          utxo: { outpoint: playerUtxo.outpoint, amount: pAmt, scriptPublicKey: playerSpk, blockDaaScore: BigInt(playerUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false } },
        { previousOutpoint: shopUtxo.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 0,
          utxo: { outpoint: shopUtxo.outpoint, amount: sAmt, scriptPublicKey: shopSpk, blockDaaScore: BigInt(shopUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false } },
      ],
      outputs: [
        { value: pAmt - fee, scriptPublicKey: newPlayerSpk },
        { value: sAmt, scriptPublicKey: newShopSpk },
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const sigHex = kaspa.createInputSignature(unsignedTx, 0, privateKey);
    const playerArgs = _buildSignedArgs(kaspa, pubkeyHex, [curHp, newGold, curLevel]);
    const playerRedeem = _buildRedeem(kaspa, playerScript);
    const playerSigScript = sigHex + playerArgs + playerRedeem;

    const shopArgs = _buildPublicArgs(kaspa, [payment]);
    const shopRedeem = _buildRedeem(kaspa, shopScript);
    const shopSigScript = shopArgs + shopRedeem;

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

  // Deploy: create Player + Shop + Opponent from faucet
  async createFromFaucet(kaspa, playerPrivateKey, pubkeyHex, hp, gold, level) {
    const rpc = await this.ensureRpc(kaspa);
    const faucetPk = new kaspa.PrivateKey(FAUCET_PRIVATE_KEY);
    const faucetAddr = faucetPk.toAddress('testnet-12');
    const faucetSpk = kaspa.payToAddressScript(faucetAddr);
    const playerAddr = playerPrivateKey.toAddress('testnet-12');
    const playerSpk = kaspa.payToAddressScript(playerAddr);

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

    // KWP-powered script building
    const covPlayerSpk = _scriptToSpk(kaspa, this.buildPlayerScript(pubkeyHex, hp, gold, level));
    const covShopSpk = _scriptToSpk(kaspa, this.buildShopScript(0));
    const covOppSpk = _scriptToSpk(kaspa, this.buildOpponentScript(50, 100));

    const playerValue = 20000000n;
    const shopValue = 20000000n;
    const oppValue = 20000000n;
    const walletValue = 20000000n;
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

  // Deploy: create Player + Shop + Opponent from wallet UTXOs
  async createPlayerAndShop(kaspa, privateKey, pubkeyHex, hp, gold, level, fundingUtxos) {
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

    const playerSpk = _scriptToSpk(kaspa, this.buildPlayerScript(pubkeyHex, hp, gold, level));
    const shopSpk = _scriptToSpk(kaspa, this.buildShopScript(0));
    const oppSpk = _scriptToSpk(kaspa, this.buildOpponentScript(50, 100));

    const playerValue = 20000000n;
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

  // --- Retire functions (KWP-powered) ---

  async retirePlayer(kaspa, privateKey, pubkeyHex, curHp, curGold, curLevel, covenantUtxo) {
    const currentScript = this.buildPlayerScript(pubkeyHex, curHp, curGold, curLevel);
    const newScript = this.buildPlayerScript(pubkeyHex, curHp, curGold, curLevel);
    const newSpk = _scriptToSpk(kaspa, newScript);
    const currentSpk = _scriptToSpk(kaspa, currentScript);
    const walletSpk = kaspa.payToAddressScript(privateKey.toAddress('testnet-12'));

    const covenantValue = BigInt(covenantUtxo.utxoEntry.amount);
    const fee = 10000n;
    const minCovValue = 5000000n;
    const withdrawAmount = covenantValue - minCovValue - fee;
    if (withdrawAmount <= 0n) return null;

    const outpoint = { transactionId: covenantUtxo.outpoint.transactionId, index: covenantUtxo.outpoint.index };
    const unsignedTx = new kaspa.Transaction({
      version: 0,
      inputs: [{ previousOutpoint: outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
        utxo: { outpoint, amount: covenantValue, scriptPublicKey: currentSpk, blockDaaScore: BigInt(covenantUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false } }],
      outputs: [
        { value: minCovValue, scriptPublicKey: newSpk },
        { value: withdrawAmount, scriptPublicKey: walletSpk },
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const sigHex = kaspa.createInputSignature(unsignedTx, 0, privateKey);
    const args = _buildSignedArgs(kaspa, pubkeyHex, [curHp, curGold, curLevel]);
    const redeem = _buildRedeem(kaspa, currentScript);
    const sigScript = sigHex + args + redeem;

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

  async retireShop(kaspa, goldCollected, shopUtxo, walletAddress) {
    const currentScript = this.buildShopScript(goldCollected);
    const newScript = this.buildShopScript(goldCollected + 1);
    const newSpk = _scriptToSpk(kaspa, newScript);
    const walletSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress));

    const shopValue = BigInt(shopUtxo.utxoEntry.amount);
    const fee = 10000n;
    const minCovValue = 5000000n;
    const withdrawAmount = shopValue - minCovValue - fee;
    if (withdrawAmount <= 0n) return null;

    const outpoint = { transactionId: shopUtxo.outpoint.transactionId, index: shopUtxo.outpoint.index };
    const argSb = new kaspa.ScriptBuilder(); argSb.addI64(1n);
    const redeemSb = new kaspa.ScriptBuilder();
    redeemSb.addData(new Uint8Array(currentScript.match(/.{2}/g).map(h => parseInt(h, 16))));
    const sigScript = argSb.toString() + redeemSb.toString();

    const signedTx = new kaspa.Transaction({
      version: 0,
      inputs: [{ previousOutpoint: outpoint, signatureScript: sigScript, sequence: 0n, sigOpCount: 0 }],
      outputs: [
        { value: withdrawAmount, scriptPublicKey: walletSpk },
        { value: minCovValue, scriptPublicKey: newSpk },
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const rpc = await this.ensureRpc(kaspa);
    const rpcResult = await rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
    return { transactionId: rpcResult.transactionId, withdrawAmount: String(withdrawAmount) };
  },

  async retireOpponent(kaspa, oppHp, oppGold, oppUtxo, walletAddress) {
    const currentScript = this.buildOpponentScript(oppHp, oppGold);
    const newScript = this.buildOpponentScript(oppHp, oppGold);
    const newSpk = _scriptToSpk(kaspa, newScript);
    const walletSpk = kaspa.payToAddressScript(new kaspa.Address(walletAddress));

    const oppValue = BigInt(oppUtxo.utxoEntry.amount);
    const fee = 10000n;
    const minCovValue = 5000000n;
    const withdrawAmount = oppValue - minCovValue - fee;
    if (withdrawAmount <= 0n) return null;

    const outpoint = { transactionId: oppUtxo.outpoint.transactionId, index: oppUtxo.outpoint.index };
    const oppArgs = _buildPublicArgs(kaspa, [oppHp, oppGold]);
    const oppRedeem = _buildRedeem(kaspa, currentScript);
    const sigScript = oppArgs + oppRedeem;

    const signedTx = new kaspa.Transaction({
      version: 0,
      inputs: [{ previousOutpoint: outpoint, signatureScript: sigScript, sequence: 0n, sigOpCount: 0 }],
      outputs: [
        { value: withdrawAmount, scriptPublicKey: walletSpk },
        { value: minCovValue, scriptPublicKey: newSpk },
      ],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const rpc = await this.ensureRpc(kaspa);
    const rpcResult = await rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
    return { transactionId: rpcResult.transactionId, withdrawAmount: String(withdrawAmount) };
  },

  // --- Player Registry ---
  REGISTRY_URL: 'https://tn12.dagknight.xyz/api',

  async registerPlayer(name, classId, level, address, txId) {
    try {
      await fetch(this.REGISTRY_URL + '/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, classId, level, address, txId }),
      });
    } catch {}
  },

  async getActivePlayers() {
    try {
      const resp = await fetch(this.REGISTRY_URL + '/players');
      return await resp.json();
    } catch { return []; }
  },
};
