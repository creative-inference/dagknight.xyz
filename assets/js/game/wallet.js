/* ============================================================
   DAGKnight BBS — Wallet (TN12 keypair + faucet funding)
   ============================================================ */

const WALLET_KEY = 'dagknight_wallet';
const FAUCET_URL = 'https://us-central1-gen-lang-client-0088192818.cloudfunctions.net/dagknight-faucet';
const WALLET_TN12_API = 'https://api-tn12.kaspa.org';

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

  // Request 1 KAS from the faucet Cloud Function
  async fund() {
    await this.ensureAddress();
    if (this._funded) return { alreadyFunded: true };

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
      // Already funded
      this._funded = true;
      this._save();
      return { alreadyFunded: true };
    } else {
      throw new Error(data.error || 'Faucet request failed');
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
