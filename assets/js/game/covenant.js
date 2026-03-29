/* ============================================================
   DAGKnight BBS — Covenant Transaction Builder
   All tx submission via wRPC to our TN12 node.
   UTXO lookups via wRPC (getUtxosByAddresses).
   160-byte contract: single update entrypoint with checkSig +
   validateOutputState. Owner = raw x-only pubkey.
   ============================================================ */

const COVENANT_NODE_WS = 'ws://157.245.8.28:18310';

// Compiled Player covenant (160 bytes, without_selector=true)
const PLAYER_SCRIPT_HEX = '20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa08140000000000000008000000000000000008010000000000000057795479876958795879ac69567900a269557900a269547978a269537901207c7e577958cd587c7e577958cd587c7e577958cd587c7e7e7e7eb976c97602a00094013c937cbc7eaa02000001aa7e01207e7c7e01877e00c3876975757575757575757551';

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
    const fee = 10000n;
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

    const redeemLen = currentScript.length / 2;
    let sigScript = sigHex + argSb.toString();
    if (redeemLen <= 255) {
      sigScript += '4c' + redeemLen.toString(16).padStart(2, '0');
    } else {
      sigScript += '4d' + (redeemLen & 0xff).toString(16).padStart(2, '0')
                        + ((redeemLen >> 8) & 0xff).toString(16).padStart(2, '0');
    }
    sigScript += currentScript;

    const signedTx = new kaspa.Transaction({
      version: 0,
      inputs: [{
        previousOutpoint: outpoint, signatureScript: sigScript, sequence: 0n, sigOpCount: 1,
      }],
      outputs: [{ value: covenantValue - fee, scriptPublicKey: newSpk }],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const rpc = await this.ensureRpc(kaspa);
    return rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
  },
};
