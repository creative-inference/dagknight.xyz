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
    const fee = 10000n;
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

    const inputs = [{
      previousOutpoint: outpoint,
      signatureScript: '',
      sequence: 0n,
      sigOpCount: 1,
      utxo: {
        outpoint,
        amount: covenantValue,
        scriptPublicKey: currentP2shSpk,
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

    // For P2SH spending, we need to construct the signatureScript manually:
    // <function_args...> <signature> <redeem_script>
    // The function selector for "update" is pushed first (OP_0 = first function)
    //
    // Stack at spend time (pushed in reverse):
    //   <redeemScript> <ownerSig> <newLevel> <newGold> <newHp> <functionSelector>
    //
    // For now, we sign the tx first to get the signature, then build the full sig_script

    // Sign to get the signature
    const signedTx = kaspa.signTransaction(tx, [privateKey], false);

    // Extract the signature from the signed input
    const signedSigScript = signedTx.inputs[0].signatureScript;

    // Build the P2SH sig_script:
    // <args> <sig> <serialized_redeem_script>
    // For the update function: newHp newGold newLevel are on stack
    // But the compiler handles this internally — we need to understand the exact stack layout
    //
    // TODO: This is the hard part — constructing the correct sig_script
    // that satisfies the covenant's update entrypoint.
    // For now, submit the signed tx as-is to see what error we get.

    return await this._submitTx(signedTx);
  },

  // Find the covenant UTXO for a player address
  async findCovenantUtxo(address, pubkeyHex, level) {
    const utxos = await this.getUtxos(address);
    // The covenant UTXO has a P2SH scriptPublicKey, not a regular P2PK
    // Regular UTXOs start with "20" (OP_PUSHBYTES_32), P2SH starts with "aa" (OP_BLAKE2B)
    return utxos.find(u => {
      const spk = u.utxoEntry?.scriptPublicKey?.scriptPublicKey || '';
      return spk.startsWith('aa');
    });
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
      throw new Error(`tx ${resp.status}: ${err.substring(0, 200)}`);
    }

    const result = await resp.json();
    return result.transactionId || signedTx.finalize().toString();
  },
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
