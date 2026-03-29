/* ============================================================
   DAGKnight BBS — Covenant Transaction Builder
   Creates and updates Player covenant UTXOs on TN12 via P2SH.
   160-byte contract: single update entrypoint with checkSig +
   validateOutputState. Owner = raw x-only pubkey.
   ============================================================ */

const COVENANT_TN12_API = 'https://api-tn12.kaspa.org';
const COVENANT_NODE_WS  = 'ws://157.245.8.28:18310';

// Compiled Player covenant (160 bytes, without_selector=true)
// update(owner_sig, owner_pk, newHp, newGold, newLevel) + validateOutputState
// owner = raw x-only pubkey at hex[2..65], state at hex[68..119]
const PLAYER_SCRIPT_HEX = '20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa08140000000000000008000000000000000008010000000000000057795479876958795879ac69567900a269557900a269547978a269537901207c7e577958cd587c7e577958cd587c7e577958cd587c7e7e7e7eb976c97602a00094013c937cbc7eaa02000001aa7e01207e7c7e01877e00c3876975757575757575757551';

function int64LE(n) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigInt64(0, BigInt(n), true);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const Covenant = {

  buildPlayerScript(pubkeyHex, hp, gold, level) {
    let s = PLAYER_SCRIPT_HEX.replaceAll('aa'.repeat(32), pubkeyHex);
    // State at hex offsets: hp 68-83, gold 86-101, level 104-119
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

  async findCovenantUtxo(address) {
    const resp = await fetch(`${COVENANT_TN12_API}/addresses/${address}/utxos`);
    const utxos = await resp.json();
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

    return kaspa.signTransaction(tx, [privateKey], false);
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

    // Unsigned tx for signing
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

    // Sign
    const sigHex = kaspa.createInputSignature(unsignedTx, 0, privateKey);

    // sig_script: <sig65> <pubkey32> <newHp> <newGold> <newLevel> <redeem>
    // No selector (without_selector=true)
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

    // Rebuild with sig_script
    return new kaspa.Transaction({
      version: 0,
      inputs: [{
        previousOutpoint: outpoint, signatureScript: sigScript, sequence: 0n, sigOpCount: 1,
      }],
      outputs: [{ value: covenantValue - fee, scriptPublicKey: newSpk }],
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });
  },

  // Submit via REST API
  async submitRest(signedTx) {
    const txJson = signedTx.toJSON();
    const apiTx = {
      transaction: {
        version: txJson.version,
        inputs: txJson.inputs.map(inp => ({
          previousOutpoint: inp.previousOutpoint, signatureScript: inp.signatureScript,
          sequence: inp.sequence, sigOpCount: inp.sigOpCount,
        })),
        outputs: txJson.outputs.map(out => ({
          amount: out.value,
          scriptPublicKey: { version: out.scriptPublicKey.version, scriptPublicKey: out.scriptPublicKey.script },
        })),
        lockTime: txJson.lockTime, subnetworkId: txJson.subnetworkId, gas: txJson.gas, payload: txJson.payload,
      },
    };

    const resp = await fetch(`${COVENANT_TN12_API}/transactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apiTx, (_, v) => typeof v === 'bigint' ? v.toString() : v),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`tx ${resp.status}: ${err.substring(0, 200)}`);
    }
    return resp.json();
  },

  // Submit via wRPC (for covenant creation — bypasses standardness check)
  async submitWrpc(rpc, signedTx) {
    return rpc.submitTransaction({ transaction: signedTx, allowOrphan: false });
  },
};

// Debug helpers
window.testCovenantCreate = async function() {
  console.log('=== Testing Covenant Create ===');
  await Wallet.ensureAddress();
  const kaspa = Wallet._kaspa;
  const pk = new kaspa.PrivateKey(Wallet._privateKeyHex);
  const pub = pk.toPublicKey().toXOnlyPublicKey().toString();
  const addr = Wallet.address;

  const fundingResp = await fetch(`${COVENANT_TN12_API}/addresses/${addr}/utxos`);
  const funding = await fundingResp.json();
  console.log('Funding UTXOs:', funding.length);

  const tx = await Covenant.createPlayerUtxo(kaspa, pk, pub, 20, 0, 1, funding);
  const result = await Covenant.submitRest(tx);
  console.log('CREATE:', result);
};

window.testCovenantUpdate = async function() {
  console.log('=== Testing Covenant Update ===');
  await Wallet.ensureAddress();
  const kaspa = Wallet._kaspa;
  const pk = new kaspa.PrivateKey(Wallet._privateKeyHex);
  const pub = pk.toPublicKey().toXOnlyPublicKey().toString();

  const covAddr = Covenant.getCovenantAddress(kaspa, pub, 20, 0, 1);
  const utxo = await Covenant.findCovenantUtxo(covAddr);
  if (!utxo) { console.log('No covenant UTXO found'); return; }

  const tx = await Covenant.updatePlayerUtxo(kaspa, pk, pub, 20, 0, 1, 15, 40, 1, utxo);
  const result = await Covenant.submitRest(tx);
  console.log('UPDATE:', result);
};
