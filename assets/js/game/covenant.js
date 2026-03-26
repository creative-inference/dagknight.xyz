/* ============================================================
   DAGKnight BBS — Covenant Transaction Builder
   Creates and spends Player covenant UTXOs on TN12
   ============================================================ */

const COVENANT_TN12_API = 'https://api-tn12.kaspa.org';

// Compiled Player covenant bytecode (from silverc)
// Contains dummy pubkey 0101...01 (32 bytes) that must be replaced
// Constructor params baked in: owner(pubkey), hp(int), gold(int), level(int)
const PLAYER_SCRIPT_TEMPLATE = '6b6c76009c63755379200101010101010101010101010101010101010101010101010101010101010101ac69527900a269517900a269007951a26900c2b9be02e80394a26900c358527958cd7e587e537958cd7e587e547958cd7eb9bf82011b7c7f7eaa02000001aa7e01207e7c7e01877e876975757575516776519c63750079200101010101010101010101010101010101010101010101010101010101010101ac697551677500696868';

// Dummy pubkey used during compilation (32 bytes of 0x01)
const DUMMY_PUBKEY = '01'.repeat(32);

const Covenant = {

  // Replace the dummy pubkey in the template with the real player pubkey
  // and splice in initial state values (hp, gold, level)
  buildPlayerScript(pubkeyHex, hp, gold, level) {
    // The constructor params are pushed in reverse order in the bytecode:
    //   level(int8), gold(int8), hp(int8), owner(pubkey32)
    // Each int is: 0x08 + 8-byte LE int64
    // Pubkey is: 0x20 + 32-byte key
    //
    // We need to replace both occurrences of the dummy pubkey
    // and the int values preceding them

    let script = PLAYER_SCRIPT_TEMPLATE;

    // Replace both dummy pubkey occurrences with real pubkey
    script = script.replaceAll(DUMMY_PUBKEY, pubkeyHex);

    // TODO: Replace the int state values (hp, gold, level) in the bytecode
    // For now, the initial values from compilation (hp=20, gold=0, level=1) are baked in
    // Full state splicing will be implemented after testing basic covenant creation

    return script;
  },

  // Create a Player covenant UTXO on TN12
  // Returns the transaction ID
  async createPlayerUtxo(kaspa, privateKey, pubkeyHex, hp, gold, level, fundingUtxos) {
    const script = this.buildPlayerScript(pubkeyHex, hp, gold, level);

    // Wrap as P2SH: OP_BLAKE2B <script_hash> OP_EQUAL
    // The redeem script is the full covenant script
    // The output scriptPublicKey is: 0xaa 0x20 <32-byte-blake2b-hash> 0x87
    const scriptBuilder = kaspa.ScriptBuilder.fromScript(script);
    const p2shSpk = scriptBuilder.createPayToScriptHashScript();


    // Build transaction
    const playerAddress = privateKey.toAddress('testnet-12');
    const playerSpk = kaspa.payToAddressScript(playerAddress);

    // Filter to only UTXOs with enough value
    const validUtxos = fundingUtxos.filter(u => BigInt(u.utxoEntry?.amount || 0) > 0n);

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

    if (inputs.length === 0) {
      throw new Error('No UTXOs available to fund covenant');
    }

    let totalInput = 0n;
    for (const inp of inputs) totalInput += inp.utxo.amount;

    const covenantValue = 50000000n; // 0.5 KAS locked in covenant
    const fee = 10000n;
    const change = totalInput - covenantValue - fee;

    const outputs = [
      { value: covenantValue, scriptPublicKey: p2shSpk },
    ];

    if (change > 0n) {
      outputs.push({ value: change, scriptPublicKey: playerSpk });
    }

    const tx = new kaspa.Transaction({
      version: 0,
      inputs,
      outputs,
      lockTime: 0n,
      subnetworkId: '0000000000000000000000000000000000000000',
      gas: 0n,
      payload: '',
    });

    // Sign
    const signedTx = kaspa.signTransaction(tx, [privateKey], false);

    // Convert to REST API format
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

    // Submit
    const resp = await fetch(`${COVENANT_TN12_API}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: apiTx }, (_, v) => typeof v === 'bigint' ? v.toString() : v),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Covenant tx ${resp.status}: ${err.substring(0, 200)}`);
    }

    const result = await resp.json();
    return result.transactionId || signedTx.finalize().toString();
  },

  // Fetch player's UTXOs from TN12
  async getUtxos(address) {
    const resp = await fetch(`${COVENANT_TN12_API}/addresses/${address}/utxos`);
    return resp.json();
  },
};

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
