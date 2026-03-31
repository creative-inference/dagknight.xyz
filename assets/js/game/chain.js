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
  emitCovenantTx(action, detail, txId) {
    if (!this._feed) return;

    const txLink = txId
      ? `<br><a href="https://tn12.kaspa.stream/transactions/${txId}" target="_blank" rel="noopener" class="ce-txlink">${txId.substring(0, 16)}...</a>`
      : '';
    const el = document.createElement('div');
    el.className = 'chain-entry covenant-tx';
    el.innerHTML =
      `<span class="ce-time">${this._timestamp()}</span> ` +
      `<span class="ce-label">COV TX</span> ` +
      `<span class="ce-label">${action}</span>` +
      `${txId === false ? '' : (txId ? '' : ' (simulated)')}<br>` +
      `<span class="ce-detail">  ${detail}</span>` +
      txLink;

    this._feed.appendChild(el);
    this._trimFeed();
    this._feed.scrollTop = this._feed.scrollHeight;
  },

  _trimFeed() {
    while (this._feed.children.length > this._maxEntries) {
      this._feed.removeChild(this._feed.firstChild);
    }
  },

  // Poll beacon address for active players
  async refreshBeacons() {
    const listEl = document.getElementById('beacon-list');
    if (!listEl) return;
    try {
      if (!Wallet._kaspa || !Covenant._rpc) {
        // Try connecting
        if (Wallet._kaspa) await Covenant.ensureRpc(Wallet._kaspa);
        else return;
      }
      const beacons = await Covenant.getActiveBeacons(Wallet._kaspa);
      if (beacons.length === 0) {
        listEl.innerHTML = '<span style="color: #555;">No active knights found.</span>';
        return;
      }
      listEl.innerHTML = beacons
        .sort((a, b) => b.level - a.level)
        .map((b, i) => {
          const txShort = b.outpoint?.transactionId?.substring(0, 12) || '?';
          return `<div style="display:flex;justify-content:space-between;border-bottom:1px solid #1a1e28;padding:2px 0;">` +
            `<span>Knight #${i + 1}</span>` +
            `<span style="color:#d4a847;">Level ${b.level}</span>` +
            `<span style="color:#555;font-size:0.75rem;">${txShort}...</span>` +
            `</div>`;
        }).join('');
    } catch {
      listEl.innerHTML = '<span style="color: #555;">Beacon scan unavailable.</span>';
    }
  },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Chain.init());
} else {
  Chain.init();
}

// Poll beacons every 30 seconds
setInterval(() => Chain.refreshBeacons(), 30000);
// Initial beacon load after 5 seconds (wait for WASM)
setTimeout(() => Chain.refreshBeacons(), 5000);
