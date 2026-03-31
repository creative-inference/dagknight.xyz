/* ============================================================
   DAGKnight BBS — Wallet (TN12 keypair + faucet funding)
   ============================================================ */

const WALLET_KEY = 'dagknight_wallet';
const FAUCET_URL = 'https://us-central1-gen-lang-client-0088192818.cloudfunctions.net/dagknight-faucet';
const WALLET_TN12_API = 'https://api-tn12.kaspa.org';
// On-node faucet: funded by our miner, submitted through our node (no relay issues)
const ON_NODE_FAUCET_KEY = 'e2e890b7101ce497fbfdb97707d3ba3bd8c727b2fa9fae81be80d629ea7581fc';

const Wallet = {
  _privateKeyHex: null,
  _address: null,
  _funded: false,

  // Load or generate keypair
  init() {
    const saved = localStorage.getItem(WALLET_KEY);
    if (saved) {
      try {
        const data = JSON.parse(saved);
        this._privateKeyHex = data.key;
        this._address = data.address;
        this._funded = data.funded || false;
      } catch {
        this._generate();
      }
    }
  },

  _generate() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    this._privateKeyHex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    this._address = null;
    this._funded = false;
  },

  // Load @kasdk/web WASM and derive address (lazy, one-time)
  async ensureAddress() {
    if (!this._privateKeyHex) this._generate();

    // Always load WASM if not loaded (needed for covenant ops)
    if (!this._kaspa) {
      const metaBase = document.querySelector('meta[name="kasdk-wasm"]')?.content || '/node_modules/@kasdk/web/';
      const wasmBase = new URL(metaBase, window.location.href).href;
      const mod = await import(wasmBase + 'kaspa.js');
      await mod.default(wasmBase + 'kaspa_bg.wasm');
      this._kaspa = mod;
    }

    if (!this._address) {
      const pk = new this._kaspa.PrivateKey(this._privateKeyHex);
      this._address = pk.toAddress('testnet-12').toString();
      this._save();
    }
    return this._address;
  },

  _save() {
    localStorage.setItem(WALLET_KEY, JSON.stringify({
      key: this._privateKeyHex,
      address: this._address,
      funded: this._funded,
    }));
  },

  get address() { return this._address; },
  get funded() { return this._funded; },

  // Fund wallet from on-node faucet (mining rewards, same node = no relay issues)
  async fund() {
    await this.ensureAddress();
    if (this._funded) return { alreadyFunded: true };

    try {
      const kaspa = this._kaspa;
      const rpc = await Covenant.ensureRpc(kaspa);
      const faucetPk = new kaspa.PrivateKey(ON_NODE_FAUCET_KEY);
      const faucetAddr = faucetPk.toAddress('testnet-12');
      const faucetSpk = kaspa.payToAddressScript(faucetAddr);
      const playerSpk = kaspa.payToAddressScript(new kaspa.Address(this._address));

      // Get mature faucet UTXOs (coinbase needs 1000 DAA score confirmations)
      const resp = await rpc.getUtxosByAddresses({ addresses: [faucetAddr.toString()] });
      const allUtxos = resp.entries || resp || [];
      const info = await rpc.getBlockDagInfo();
      const daa = Number(info.virtualDaaScore);
      const utxos = allUtxos.filter(u => (daa - Number((u.entry || u).blockDaaScore)) > 1100);
      if (!utxos.length) throw new Error('No mature faucet UTXOs — mining rewards need ~2 min to mature');

      const u = utxos[0];
      const e = u.entry || u;
      const amount = BigInt(e.amount);
      const sendAmount = 100000000n; // 1 KAS
      const fee = 5000n;
      if (amount < sendAmount + fee) throw new Error('Faucet UTXO too small');

      const change = amount - sendAmount - fee;
      const outputs = [{ value: sendAmount, scriptPublicKey: playerSpk }];
      if (change > 0n) outputs.push({ value: change, scriptPublicKey: faucetSpk });

      const tx = new kaspa.Transaction({
        version: 0,
        inputs: [{
          previousOutpoint: u.outpoint, signatureScript: '', sequence: 0n, sigOpCount: 1,
          utxo: { outpoint: u.outpoint, amount, scriptPublicKey: faucetSpk, blockDaaScore: BigInt(e.blockDaaScore || 0), isCoinbase: e.isCoinbase || false },
        }],
        outputs,
        lockTime: 0n, subnetworkId: '0000000000000000000000000000000000000000', gas: 0n, payload: '',
      });

      const signed = kaspa.signTransaction(tx, [faucetPk], false);
      const result = await rpc.submitTransaction({ transaction: signed, allowOrphan: false });

      this._funded = true;
      this._save();
      return { txId: result.transactionId, amount: Number(sendAmount) };
    } catch (err) {
      // Fall back to Cloud Function faucet
      const resp = await fetch(FAUCET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: this._address }),
      });
      const data = await resp.json();
      if (resp.ok) {
        this._funded = true;
        this._save();
        return { txId: data.txId, amount: data.amount };
      } else if (resp.status === 429) {
        this._funded = true;
        this._save();
        return { alreadyFunded: true };
      } else {
        throw new Error(data.error || err.message);
      }
    }
  },

  // Check balance via REST API
  async getBalance() {
    if (!this._address) return 0;
    try {
      const resp = await fetch(`${WALLET_TN12_API}/addresses/${this._address}/balance`);
      const data = await resp.json();
      return parseInt(data.balance || '0', 10);
    } catch {
      return 0;
    }
  },
};
