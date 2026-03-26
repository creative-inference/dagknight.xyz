/**
 * DAG Gate Faucet — Cloud Function (Node.js)
 *
 * Sends 1 test KAS to new players on character creation.
 * Faucet private key stored in GCP Secret Manager.
 * Transaction built with kaspa-wasm and submitted via TN12 REST API.
 * Rate limited: 1 fund per address (tracked in Firestore).
 */

const functions = require('@google-cloud/functions-framework');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
const { Firestore } = require('@google-cloud/firestore');

const TN12_API = 'https://api-tn12.kaspa.org';
const GCP_PROJECT = process.env.GCP_PROJECT || 'gen-lang-client-0088192818';
const FUND_AMOUNT = 100_000_000n; // 1 KAS in sompi
const FAUCET_SECRET = 'dagknight-faucet-private-key';
const FAUCET_ADDRESS_SECRET = 'dagknight-faucet-address';

let kaspa = null;

async function loadKaspa() {
  if (kaspa) return kaspa;
  kaspa = require('@kasdk/nodejs');
  return kaspa;
}

async function getSecret(name) {
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: `projects/${GCP_PROJECT}/secrets/${name}/versions/latest`,
  });
  return version.payload.data.toString('utf-8').trim();
}

async function checkRateLimit(address) {
  const db = new Firestore({ projectId: GCP_PROJECT });
  const doc = await db.collection('dagknight_faucet').doc(address).get();
  return !doc.exists;
}

async function recordFund(address, txId) {
  const db = new Firestore({ projectId: GCP_PROJECT });
  await db.collection('dagknight_faucet').doc(address).set({
    funded_at: Date.now(),
    tx_id: txId,
    amount: Number(FUND_AMOUNT),
  });
}

functions.http('fund', async (req, res) => {
  // CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST required' });
  }

  try {
    const { address } = req.body || {};

    if (!address || !address.startsWith('kaspatest:')) {
      return res.status(400).json({ error: 'valid kaspatest: address required' });
    }

    // Rate limit
    const allowed = await checkRateLimit(address);
    if (!allowed) {
      return res.status(429).json({ error: 'address already funded' });
    }

    // Load SDK and secrets
    const ksp = await loadKaspa();
    const faucetKeyHex = await getSecret(FAUCET_SECRET);
    const faucetAddr = await getSecret(FAUCET_ADDRESS_SECRET);

    // Fetch faucet UTXOs
    const utxoResp = await fetch(`${TN12_API}/addresses/${faucetAddr}/utxos`);
    const utxos = await utxoResp.json();

    if (!utxos || utxos.length === 0) {
      return res.status(503).json({ error: 'faucet has no UTXOs' });
    }

    // Select UTXOs
    const fee = 10_000n;
    const needed = FUND_AMOUNT + fee;
    let total = 0n;
    const selected = [];

    for (const utxo of utxos) {
      const amt = BigInt(utxo.utxoEntry?.amount || 0);
      selected.push(utxo);
      total += amt;
      if (total >= needed) break;
    }

    if (total < needed) {
      return res.status(503).json({ error: `insufficient faucet balance: ${total}` });
    }

    // Build transaction using kaspa-wasm
    const privateKey = new ksp.PrivateKey(faucetKeyHex);
    const recipientAddr = new ksp.Address(address);
    const faucetAddress = new ksp.Address(faucetAddr);

    const faucetSpk = ksp.payToAddressScript(faucetAddress);

    const inputs = selected.map(utxo => {
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
          scriptPublicKey: faucetSpk,
          blockDaaScore: BigInt(utxo.utxoEntry.blockDaaScore || 0),
          isCoinbase: utxo.utxoEntry.isCoinbase || false,
        },
      };
    });

    const outputs = [
      { value: FUND_AMOUNT, scriptPublicKey: ksp.payToAddressScript(recipientAddr) },
    ];

    const change = total - FUND_AMOUNT - fee;
    if (change > 0n) {
      outputs.push({ value: change, scriptPublicKey: faucetSpk });
    }

    const tx = new ksp.Transaction({
      version: 0,
      inputs,
      outputs,
      lockTime: 0n,
      subnetworkId: '0000000000000000000000000000000000000000',
      gas: 0n,
      payload: '',
    });

    // Sign all inputs
    const signedTx = ksp.signTransaction(tx, [privateKey], false);

    // Convert SDK format to REST API format
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

    // Submit via REST API
    const submitResp = await fetch(`${TN12_API}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: apiTx }, (_, v) => typeof v === 'bigint' ? v.toString() : v),
    });

    if (!submitResp.ok) {
      const err = await submitResp.text();
      console.error('Submit failed:', submitResp.status, err);
      return res.status(502).json({ error: `tx submit failed: ${err}` });
    }

    const result = await submitResp.json();
    const txId = result.transactionId || signedTx.finalize().toString();

    // Record in Firestore
    await recordFund(address, txId);

    console.log(`Funded ${address} with ${FUND_AMOUNT} sompi, tx: ${txId}`);

    return res.status(200).json({
      txId,
      amount: Number(FUND_AMOUNT),
      faucet: faucetAddr,
    });

  } catch (err) {
    console.error('Faucet error:', err);
    return res.status(500).json({ error: err.message });
  }
});
