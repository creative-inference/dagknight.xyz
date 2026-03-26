/* ============================================================
   DAGKnight BBS — Covenant Transaction Builder
   Creates and spends Player covenant UTXOs on TN12 via P2SH
   ============================================================ */

const COVENANT_TN12_API = 'https://api-tn12.kaspa.org';

// Compiled Player covenant bytecode (KIP-20 covenant declarations)
// ABI: __update(ownerSig, newHp, newGold, newLevel), withdraw(ownerSig)
// Dummy pubkey (0xAA x32) at two locations. State ints at bytes 2-25.
const PLAYER_SCRIPT_HEX = '6b0814000000000000000800000000000000000801000000000000006c76009c6375567920aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac69557900a269547900a26953795179a269b9cb519c69557958cd587c7e557958cd587c7e557958cd587c7e7e7eb976c902e10094765193bc7c7eb976c97602e10094011c937cbc7eaa02000001aa7e01207e7c7e01877eb900ccc3876975757575757575516776519c6375537920aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac697575757551677500696868';

const DUMMY_PUBKEY = 'aa'.repeat(32);

// Encode an int as 8-byte little-endian hex
function int64LE(n) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigInt64(0, BigInt(n), true);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

const Covenant = {

  // Build covenant script with real pubkey and state
  buildPlayerScript(pubkeyHex, hp, gold, level) {
    let script = PLAYER_SCRIPT_HEX;
    script = script.replaceAll(DUMMY_PUBKEY, pubkeyHex);
    // Replace baked-in state: hp=20(0x14), gold=0, level=1 with actual values
    script = script.replace(
      '08' + '1400000000000000' + '08' + '0000000000000000' + '08' + '0100000000000000',
      '08' + int64LE(hp) + '08' + int64LE(gold) + '08' + int64LE(level)
    );
    return script;
  },

  // Create a Player covenant UTXO (P2SH)
  async createPlayerUtxo(kaspa, privateKey, pubkeyHex, hp, gold, level, fundingUtxos) {
    const script = this.buildPlayerScript(pubkeyHex, hp, gold, level);
    const covenantSpk = kaspa.ScriptBuilder.fromScript(script).createPayToScriptHashScript();

    const playerAddress = privateKey.toAddress('testnet-12');
    const playerSpk = kaspa.payToAddressScript(playerAddress);

    const validUtxos = fundingUtxos.filter(u => BigInt(u.utxoEntry?.amount || 0) > 0n);
    if (validUtxos.length === 0) throw new Error('No UTXOs available');

    const inputs = validUtxos.map(utxo => {
      const outpoint = { transactionId: utxo.outpoint.transactionId, index: utxo.outpoint.index };
      return {
        previousOutpoint: outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
        utxo: {
          outpoint, amount: BigInt(utxo.utxoEntry.amount), scriptPublicKey: playerSpk,
          blockDaaScore: BigInt(utxo.utxoEntry.blockDaaScore || 0), isCoinbase: false,
        },
      };
    });

    let totalInput = 0n;
    for (const inp of inputs) totalInput += inp.utxo.amount;
    const covenantValue = 10000000n; // 0.1 KAS locked in covenant
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
    return await this._submitTx(signedTx);
  },

  // Spend the Player covenant — withdraw (destroy and reclaim KAS)
  // This is the simplest spend: just needs a signature, no state update
  async withdrawPlayerUtxo(kaspa, privateKey, pubkeyHex, hp, gold, level, covenantUtxo) {
    const currentScript = this.buildPlayerScript(pubkeyHex, hp, gold, level);

    // Withdraw sends KAS back to the player's regular address
    const playerAddress = privateKey.toAddress('testnet-12');
    const playerSpk = kaspa.payToAddressScript(playerAddress);

    const covenantValue = BigInt(covenantUtxo.utxoEntry.amount);
    const fee = 10000n + BigInt(Math.floor(Math.random() * 1000));
    const outValue = covenantValue - fee;

    const outpoint = { transactionId: covenantUtxo.outpoint.transactionId, index: covenantUtxo.outpoint.index };

    // P2SH signing uses the P2SH scriptPublicKey (confirmed working with withdraw)
    const onChainSpk = kaspa.ScriptBuilder.fromScript(currentScript).createPayToScriptHashScript();

    const inputs = [{
      previousOutpoint: outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
      utxo: {
        outpoint, amount: covenantValue, scriptPublicKey: onChainSpk,
        blockDaaScore: BigInt(covenantUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false,
      },
    }];

    const outputs = [{ value: outValue, scriptPublicKey: playerSpk }];

    const tx = new kaspa.Transaction({
      version: 0, inputs, outputs,
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    // Sign with the redeem script
    const sig = kaspa.createInputSignature(tx, 0, privateKey);

    // Kaspa P2SH sig_script format (from payToScriptHashSignatureScript):
    //   <push_only_script_bytes> <OP_PUSHDATA1> <len> <redeem_script>
    //
    // The P2SH engine splits at the last data push, uses it as redeem script,
    // and parses everything before as a push-only script for the stack.
    //
    // Stack needed (top first): [functionSelector] [ownerSig]
    // Push order: sig first, selector second (selector = top of stack)
    // createInputSignature returns 65 bytes: 64-byte Schnorr sig + 0x01 sighash type
    // Kaspa OP_CHECKSIG wants the full 65 bytes as one stack item
    // But "invalid signature length 65" means it wants 64.
    // Try: push sig as raw 65 bytes in the payToScriptHashSignatureScript format
    // (raw concat, no push opcodes — the P2SH engine handles the framing)
    //
    // Actually — the "invalid hash type 0x63" with 64 bytes means the node
    // reads byte 65 as sighash. With 65 bytes it says "invalid length".
    // The answer: OP_CHECKSIG in Kaspa reads exactly 64 bytes from stack,
    // AND reads the sighash type from a separate mechanism (SigHashType in tx).
    // So push exactly 64 bytes (strip trailing 0x01).
    // Push: 64-byte sig, then sighash type, then function selector
    // OP_CHECKSIG consumes [sig][pubkey] but the sig format may need the sighash
    // Let's try keeping the full 65-byte sig (with 0x01 sighash appended)
    // but push it using addData which uses OP_PUSHBYTES_65
    //
    // The real question: does Kaspa checksig pop N bytes or does it expect
    // exactly 64? Let's just test both — 64 first, if "invalid hash type"
    // then 65 is needed.
    // Kaspa OP_CHECKSIG reads 64 bytes as sig + 1 byte as sighash type = 65 bytes total
    // createInputSignature returns exactly this: 64-byte sig + 0x01
    // But addData(65 bytes) causes "invalid signature length 65" — the OP_CHECKSIG
    // must be reading the size from the push opcode, not the data.
    //
    // Solution: don't use addData. Push the sig using the SDK's native sig format.
    // payToScriptHashSignatureScript puts the sig as RAW bytes (no push opcode).
    // So use raw concat for the sig, push opcodes for the rest.
    //
    // Format: <raw_sig_65_bytes> <push(selector)> <OP_PUSHDATA1(redeem)>
    const sigHex = sig; // 65 bytes = 130 hex chars

    // Selector as a push: OP_1 = 0x51
    const selectorHex = '51';

    // Redeem script with OP_PUSHDATA1
    const redeemLen = currentScript.length / 2;
    const redeemLenHex = redeemLen.toString(16).padStart(2, '0');

    tx.inputs[0].signatureScript = sigHex + selectorHex + '4c' + redeemLenHex + currentScript;

    return await this._submitTx(tx);
  },

  // Spend the Player covenant — update state and recreate
  async updatePlayerUtxo(kaspa, privateKey, pubkeyHex,
    curHp, curGold, curLevel,
    newHp, newGold, newLevel,
    covenantUtxo
  ) {
    const currentScript = this.buildPlayerScript(pubkeyHex, curHp, curGold, curLevel);
    const newScript = this.buildPlayerScript(pubkeyHex, newHp, newGold, newLevel);

    // New P2SH output with updated state
    const newCovenantSpk = kaspa.ScriptBuilder.fromScript(newScript).createPayToScriptHashScript();

    const covenantValue = BigInt(covenantUtxo.utxoEntry.amount);
    const fee = 10000n + BigInt(Math.floor(Math.random() * 1000));
    const outValue = covenantValue - fee;

    const outpoint = { transactionId: covenantUtxo.outpoint.transactionId, index: covenantUtxo.outpoint.index };
    const onChainSpk = kaspa.ScriptBuilder.fromScript(currentScript).createPayToScriptHashScript();

    const inputs = [{
      previousOutpoint: outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
      utxo: {
        outpoint, amount: covenantValue, scriptPublicKey: onChainSpk,
        blockDaaScore: BigInt(covenantUtxo.utxoEntry.blockDaaScore || 0), isCoinbase: false,
      },
    }];

    // Output: new covenant UTXO with updated state
    const outputs = [{ value: outValue, scriptPublicKey: newCovenantSpk }];

    const tx = new kaspa.Transaction({
      version: 0, inputs, outputs,
      lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
    });

    const sig = kaspa.createInputSignature(tx, 0, privateKey);

    // sig_script: <sig_push> <newHp_push> <newGold_push> <newLevel_push> <OP_0> <redeem_push>
    // sig already has push opcode from createInputSignature
    // args need ScriptBuilder push encoding
    const argsPush = new kaspa.ScriptBuilder()
      .addI64(BigInt(newHp))
      .addI64(BigInt(newGold))
      .addI64(BigInt(newLevel))
      .toString();

    const redeemLen = currentScript.length / 2;
    const redeemLenHex = redeemLen.toString(16).padStart(2, '0');

    // OP_0 = 0x00 for function selector (update is function 0)
    tx.inputs[0].signatureScript = sig + argsPush + '00' + '4c' + redeemLenHex + currentScript;

    return await this._submitTx(tx);
  },

  // P2SH address for a covenant
  getCovenantAddress(kaspa, pubkeyHex, hp, gold, level) {
    const script = this.buildPlayerScript(pubkeyHex, hp, gold, level);
    const p2shSpk = kaspa.ScriptBuilder.fromScript(script).createPayToScriptHashScript();
    return kaspa.addressFromScriptPublicKey(p2shSpk, 'testnet-12')?.toString();
  },

  // Find covenant UTXO at the P2SH address
  async findCovenantUtxo(kaspa, pubkeyHex, hp, gold, level) {
    const addr = this.getCovenantAddress(kaspa, pubkeyHex, hp, gold, level);
    if (!addr) return null;
    const utxos = await this.getUtxos(addr);
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
        previousOutpoint: inp.previousOutpoint, signatureScript: inp.signatureScript,
        sequence: inp.sequence, sigOpCount: inp.sigOpCount,
      })),
      outputs: txJson.outputs.map(out => ({
        amount: out.value,
        scriptPublicKey: { version: out.scriptPublicKey.version, scriptPublicKey: out.scriptPublicKey.script },
      })),
      lockTime: txJson.lockTime, subnetworkId: txJson.subnetworkId, gas: txJson.gas, payload: txJson.payload,
    };

    const resp = await fetch(`${COVENANT_TN12_API}/transactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: apiTx }, (_, v) => typeof v === 'bigint' ? v.toString() : v),
    });

    if (!resp.ok) {
      const err = await resp.text();
      console.error('=== TX REJECTED ===\n' + err);
      throw new Error(`tx ${resp.status}: ${err.substring(0, 200)}`);
    }
    console.log('=== TX ACCEPTED ===');
    const result = await resp.json();
    return result.transactionId || signedTx.finalize().toString();
  },
};

// Debug: test covenant creation + withdraw from console
window.testCovenantCreate = async function() {
  console.log('=== Testing Covenant Create ===');
  await Wallet.ensureAddress();
  const kaspa = Wallet._kaspa;
  const pk = new kaspa.PrivateKey(Wallet._privateKeyHex);
  const pub = pk.toPublicKey().toXOnlyPublicKey().toString();
  const utxos = await Covenant.getUtxos(Wallet.address);
  console.log('UTXOs:', utxos.length, 'total:', utxos.reduce((s, u) => s + BigInt(u.utxoEntry.amount), 0n).toString());
  try {
    const txId = await Covenant.createPlayerUtxo(kaspa, pk, pub, 20, 0, 1, utxos);
    console.log('CREATE SUCCESS:', txId);
    return txId;
  } catch (e) { console.error('Create failed:', e.message); }
};

window.testCovenantWithdraw = async function() {
  console.log('=== Testing Covenant Withdraw ===');
  await Wallet.ensureAddress();
  const kaspa = Wallet._kaspa;
  const pk = new kaspa.PrivateKey(Wallet._privateKeyHex);
  const pub = pk.toPublicKey().toXOnlyPublicKey().toString();
  const utxo = await Covenant.findCovenantUtxo(kaspa, pub, 20, 0, 1);
  if (!utxo) { console.error('No covenant UTXO found'); return; }
  console.log('Found:', utxo);
  try {
    const txId = await Covenant.withdrawPlayerUtxo(kaspa, pk, pub, 20, 0, 1, utxo);
    console.log('WITHDRAW SUCCESS:', txId);
    return txId;
  } catch (e) { console.error('Withdraw failed:', e.message); }
};

window.testCovenantUpdate = async function() {
  console.log('=== Testing Covenant Update ===');
  await Wallet.ensureAddress();
  const kaspa = Wallet._kaspa;
  const pk = new kaspa.PrivateKey(Wallet._privateKeyHex);
  const pub = pk.toPublicKey().toXOnlyPublicKey().toString();

  // Find covenant at hp=20, gold=0, level=1 (initial state)
  const utxo = await Covenant.findCovenantUtxo(kaspa, pub, 20, 0, 1);
  if (!utxo) { console.error('No covenant UTXO found at (20,0,1)'); return; }
  console.log('Found:', utxo);
  console.log('Updating: hp 20→20, gold 0→0, level 1→1 (same state — test basic spend)');
  try {
    const txId = await Covenant.updatePlayerUtxo(
      kaspa, pk, pub,
      20, 0, 1,     // current state
      20, 0, 1,     // new state (SAME — test that covenant accepts recreation)
      utxo
    );
    console.log('UPDATE SUCCESS:', txId);
    return txId;
  } catch (e) { console.error('Update failed:', e.message); }
};
