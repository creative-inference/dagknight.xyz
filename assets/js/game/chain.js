/* ============================================================
   DAGKnight BBS — Chain Activity Log
   Live TN12 block feed via REST API + simulated covenant txs
   ============================================================ */

const TN12_API = 'https://api-tn12.kaspa.org';

const Chain = {
  _feed: null,
  _statusEl: null,
  _maxEntries: 40,
  _lastDaa: 0,
  _connected: false,
  _pollInterval: null,

  init() {
    this._feed = document.getElementById('chain-feed');
    this._statusEl = document.querySelector('.chain-status');
    if (!this._feed) return;
    this._connect();
  },

  async _connect() {
    try {
      const resp = await fetch(`${TN12_API}/info/blockdag`);
      const dag = await resp.json();
      this._lastDaa = dag.virtualDaaScore;
      this._connected = true;

      // Update status indicator
      if (this._statusEl) {
        this._statusEl.innerHTML = '<span class="chain-dot chain-dot-live"></span> TN12 LIVE';
      }

      // Show initial network info
      this._addInfo(`Connected to ${dag.networkName}`);
      this._addInfo(`DAA: ${dag.virtualDaaScore} | Blocks: ${dag.blockCount} | Difficulty: ${Math.floor(dag.difficulty)}`);

      // Block polling disabled — log only shows covenant txs
    } catch (e) {
      this._connected = false;
      if (this._statusEl) {
        this._statusEl.innerHTML = '<span class="chain-dot"></span> SIMULATED (TN12 unavailable)';
      }
      this._addInfo('TN12 connection failed — showing simulated data');
    }
  },

  async _poll() {
    try {
      const dag = await fetch(`${TN12_API}/info/blockdag`).then(r => r.json());
      if (dag.virtualDaaScore > this._lastDaa) {
        const delta = dag.virtualDaaScore - this._lastDaa;
        this._lastDaa = dag.virtualDaaScore;
        const tipHash = dag.tipHashes?.[0] || '';
        this._addBlock(tipHash, delta, dag.tipHashes?.length || 1, dag.virtualDaaScore);
      }
    } catch {
      // Silently skip failed polls
    }
  },

  _timestamp() {
    const now = new Date();
    return now.toTimeString().slice(0, 8);
  },

  _addInfo(text) {
    if (!this._feed) return;
    const el = document.createElement('div');
    el.className = 'chain-entry';
    el.innerHTML = `<span class="ce-time">${this._timestamp()}</span> <span class="ce-info">${text}</span>`;
    this._feed.appendChild(el);
    this._trimFeed();
    this._feed.scrollTop = this._feed.scrollHeight;
  },

  _addBlock(hash, blocksDelta, tips, daa) {
    if (!this._feed) return;
    const el = document.createElement('div');
    el.className = 'chain-entry';
    el.innerHTML =
      `<span class="ce-time">${this._timestamp()}</span> ` +
      `+<span class="ce-txs">${blocksDelta}</span> blocks ` +
      `<span class="ce-hash">${hash.slice(0, 14)}...</span> ` +
      `<span class="ce-parents">${tips}t</span> ` +
      `DAA:<span class="ce-hash">${daa}</span>`;
    this._feed.appendChild(el);
    this._trimFeed();
    this._feed.scrollTop = this._feed.scrollHeight;
  },

  // Simulated covenant tx flash on game actions
  emitCovenantTx(action, detail) {
    if (!this._feed) return;

    const el = document.createElement('div');
    el.className = 'chain-entry covenant-tx';
    el.innerHTML =
      `<span class="ce-time">${this._timestamp()}</span> ` +
      `<span class="ce-label">COV TX</span> ` +
      `<span class="ce-label">${action}</span>` +
      `${this._connected ? '' : ' (simulated)'}<br>` +
      `<span class="ce-detail">  ${detail}</span>`;

    this._feed.appendChild(el);
    this._trimFeed();
    this._feed.scrollTop = this._feed.scrollHeight;
  },

  _trimFeed() {
    while (this._feed.children.length > this._maxEntries) {
      this._feed.removeChild(this._feed.firstChild);
    }
  },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Chain.init());
} else {
  Chain.init();
}
