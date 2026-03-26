/* ============================================================
   DAGKnight BBS — Covenant Transaction Builder
   Creates and spends Player covenant UTXOs on TN12
   ============================================================ */

const COVENANT_TN12_API = 'https://api-tn12.kaspa.org';

// Compiled Player covenant bytecode (from silverc with dummy values)
// Pubkey at offsets 10-41 and 131-162 (dummy: 0x01 x32)
// Level at offset 56 (byte after 0x01 push opcode at offset 55)
// hp and gold are runtime args, not baked in
const PLAYER_SCRIPT_TEMPLATE = '6b6c76009c6375537920{PUBKEY}ac69527900a269517900a26900790{LEVEL}a26900c2b9be02e80394a26900c358527958cd7e587e537958cd7e587e547958cd7eb9bf82011b7c7f7eaa02000001aa7e01207e7c7e01877e876975757575516776519c637500792{PUBKEY}ac697551677500696868';

// Note: level=1 encodes as "151" (OP_1), level=2-16 as "52"-"60"
// For level > 16, it's "01{hex}" (OP_PUSHBYTES_1 + byte)
function encodeLevelOpcode(level) {
  if (level === 0) return '00';           // OP_0
  if (level >= 1 && level <= 16) return (80 + level).toString(16); // OP_1 through OP_16
  // For values > 16, use OP_PUSHBYTES_1 + byte
  return '01' + level.toString(16).padStart(2, '0');
}

const Covenant = {

  // Build the covenant script with real pubkey and level
  buildPlayerScript(pubkeyHex, level) {
    const levelHex = encodeLevelOpcode(level);
    let script = PLAYER_SCRIPT_TEMPLATE
      .replaceAll('{PUBKEY}', pubkeyHex)
      .replace('{LEVEL}', levelHex);
    return script;
  },

  // Create a Player covenant UTXO on TN12
  async createPlayerUtxo(kaspa, privateKey, pubkeyHex, level, fundingUtxos) {
    const script = this.buildPlayerScript(pubkeyHex, level);
    const scriptBuilder = kaspa.ScriptBuilder.fromScript(script);
    const p2shSpk = scriptBuilder.createPayToScriptHashScript();

    const playerAddress = privateKey.toAddress('testnet-12');
    const playerSpk = kaspa.payToAddressScript(playerAddress);

    const validUtxos = fundingUtxos.filter(u => BigInt(u.utxoEntry?.amount || 0) > 0n);
    if (validUtxos.length === 0) throw new Error('No UTXOs available');

    const inputs = validUtxos.map(utxo => {
      const outpoint = {
        transactionId: utxo.outpoint.transactionId,
        index: utxo.outpoint.index,
      };
      return {
        previousOutpoint: outpoint,
        signatureScript: '',
        sequence: 0n,
        sigOpCount: 1,
        utxo: {
          outpoint,
          amount: BigInt(utxo.utxoEntry.amount),
          scriptPublicKey: playerSpk,
          blockDaaScore: BigInt(utxo.utxoEntry.blockDaaScore || 0),
          isCoinbase: utxo.utxoEntry.isCoinbase || false,
        },
      };
    });

    let totalInput = 0n;
    for (const inp of inputs) totalInput += inp.utxo.amount;

    const covenantValue = 50000000n; // 0.5 KAS locked
    const fee = 10000n;
    if (totalInput < covenantValue + fee) throw new Error('Insufficient funds');
    const change = totalInput - covenantValue - fee;

    const outputs = [{ value: covenantValue, scriptPublicKey: p2shSpk }];
    if (change > 0n) outputs.push({ value: change, scriptPublicKey: playerSpk });

    const tx = new kaspa.Transaction({
      version: 0, inputs, outputs,
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000',
      gas: 0n, payload: '',
    });

    const signedTx = kaspa.signTransaction(tx, [privateKey], false);
    return await this._submitTx(signedTx);
  },

  // Spend the Player covenant UTXO to update state (level up)
  // This consumes the current covenant UTXO and creates a new one with updated level
  async spendPlayerUtxo(kaspa, privateKey, pubkeyHex, currentLevel, newLevel, covenantUtxo) {
    // Current covenant script (the one being spent)
    const currentScript = this.buildPlayerScript(pubkeyHex, currentLevel);
    const currentScriptBytes = hexToBytes(currentScript);

    // New covenant script with updated level
    const newScript = this.buildPlayerScript(pubkeyHex, newLevel);
    const newScriptBuilder = kaspa.ScriptBuilder.fromScript(newScript);
    const newP2shSpk = newScriptBuilder.createPayToScriptHashScript();

    const covenantValue = BigInt(covenantUtxo.utxoEntry.amount);
    const fee = 10000n + BigInt(Math.floor(Math.random() * 1000)); // jitter to avoid tx hash collisions
    const outValue = covenantValue - fee;

    // The P2SH scriptPublicKey of the current covenant
    const currentScriptBuilder = kaspa.ScriptBuilder.fromScript(currentScript);
    const currentP2shSpk = currentScriptBuilder.createPayToScriptHashScript();

    // Build the sig_script (witness) for spending:
    // For the "update" function: <newLevel> <newGold> <newHp> <ownerSig> <redeemScript>
    // Function selector: 0 = update (first entrypoint)
    // The sig will be added by signTransaction, but P2SH needs the redeem script appended

    const outpoint = {
      transactionId: covenantUtxo.outpoint.transactionId,
      index: covenantUtxo.outpoint.index,
    };

    // For P2SH signing, the UTXO scriptPublicKey must be the REDEEM script
    // (not the P2SH wrapper) so the signing hash is computed correctly
    const redeemSpk = new kaspa.ScriptPublicKey(0, currentScript);

    const inputs = [{
      previousOutpoint: outpoint,
      signatureScript: '',
      sequence: 0n,
      sigOpCount: 1,
      utxo: {
        outpoint,
        amount: covenantValue,
        scriptPublicKey: redeemSpk,  // redeem script for signing hash
        blockDaaScore: BigInt(covenantUtxo.utxoEntry.blockDaaScore || 0),
        isCoinbase: false,
      },
    }];

    const outputs = [{ value: outValue, scriptPublicKey: newP2shSpk }];

    const tx = new kaspa.Transaction({
      version: 0, inputs, outputs,
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000',
      gas: 0n, payload: '',
    });

    // Create signature using the redeem script for the signing hash
    const sig = kaspa.createInputSignature(tx, 0, privateKey);

    // Kaspa P2SH sig_script is NOT a sequence of push opcodes.
    // payToScriptHashSignatureScript does raw concatenation: sig + redeemScript.
    //
    // For covenant entrypoints with function args, we need to encode the args
    // into a "virtual" sig_script that the SilverScript runtime unpacks.
    //
    // From the SilverScript compiler: the sig_script for a multi-entrypoint
    // contract should be built using the compiler's build_sig_script method.
    // Since we can't call that from JS, we use payToScriptHashSignatureScript
    // which handles the basic format, and encode args as a ScriptBuilder
    // prefix that gets pushed before the sig.
    //
    // Actually: Kaspa P2SH sig_scripts ARE push-only scripts.
    // The "disabled opcode" error means OP_PUSHDATA1 (0x4c) is disabled.
    // We need to split the redeem script into chunks <= 75 bytes
    // and push each chunk, or find the right encoding.
    //
    // Simplest test: try the withdraw function (no args, just sig)
    // to verify basic P2SH spending works first.

    // Use withdraw function (selector = 1) — no args needed, just sig
    const sigScript = kaspa.payToScriptHashSignatureScript(currentScript, sig);
    tx.inputs[0].signatureScript = sigScript;

    return await this._submitTx(tx);
  },

  // Derive the P2SH address for a covenant script
  getCovenantAddress(kaspa, pubkeyHex, level) {
    const script = this.buildPlayerScript(pubkeyHex, level);
    const scriptBuilder = kaspa.ScriptBuilder.fromScript(script);
    const p2shSpk = scriptBuilder.createPayToScriptHashScript();
    // Convert P2SH scriptPublicKey to an address
    const addr = kaspa.addressFromScriptPublicKey(p2shSpk, 'testnet-12');
    return addr?.toString();
  },

  // Find the covenant UTXO by querying the P2SH address
  async findCovenantUtxo(kaspa, pubkeyHex, level) {
    const covenantAddr = this.getCovenantAddress(kaspa, pubkeyHex, level);
    if (!covenantAddr) return null;
    const utxos = await this.getUtxos(covenantAddr);
    return utxos && utxos.length > 0 ? utxos[0] : null;
  },

  async getUtxos(address) {
    const resp = await fetch(`${COVENANT_TN12_API}/addresses/${address}/utxos`);
    return resp.json();
  },

  async _submitTx(signedTx) {
    const txJson = signedTx.toJSON();
    const apiTx = {
      version: txJson.version,
      inputs: txJson.inputs.map(inp => ({
        previousOutpoint: inp.previousOutpoint,
        signatureScript: inp.signatureScript,
        sequence: inp.sequence,
        sigOpCount: inp.sigOpCount,
      })),
      outputs: txJson.outputs.map(out => ({
        amount: out.value,
        scriptPublicKey: {
          version: out.scriptPublicKey.version,
          scriptPublicKey: out.scriptPublicKey.script,
        },
      })),
      lockTime: txJson.lockTime,
      subnetworkId: txJson.subnetworkId,
      gas: txJson.gas,
      payload: txJson.payload,
    };

    const resp = await fetch(`${COVENANT_TN12_API}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: apiTx }, (_, v) => typeof v === 'bigint' ? v.toString() : v),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('TX REJECTED:', err);
      console.error('Submitted:', JSON.stringify(apiTx, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
      throw new Error(`tx ${resp.status}: ${err.substring(0, 200)}`);
    }

    const result = await resp.json();
    return result.transactionId || signedTx.finalize().toString();
  },
};

// Debug: test covenant spend from console
// Usage: testCovenantSpend()
window.testCovenantSpend = async function() {
  console.log('=== Testing Covenant Spend ===');
  await Wallet.ensureAddress();
  if (!Wallet._kaspa) { console.error('WASM not loaded'); return; }

  const kaspa = Wallet._kaspa;
  const pk = new kaspa.PrivateKey(Wallet._privateKeyHex);
  const pubkeyHex = pk.toPublicKey().toString();

  // Find covenant at level 1 (or whatever it was created at)
  for (let lvl = 1; lvl <= 12; lvl++) {
    const utxo = await Covenant.findCovenantUtxo(kaspa, pubkeyHex, lvl);
    if (utxo) {
      console.log(`Found covenant UTXO at level ${lvl}:`, utxo);
      console.log('Attempting spend: level', lvl, '→', lvl + 1);
      try {
        const txId = await Covenant.spendPlayerUtxo(kaspa, pk, pubkeyHex, lvl, lvl + 1, utxo);
        console.log('SUCCESS! TX:', txId);
        return txId;
      } catch (e) {
        console.error('Spend failed:', e.message);
        return;
      }
    }
  }
  console.error('No covenant UTXO found at any level');
};

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
