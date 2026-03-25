/* ============================================================
   DAGKnight BBS — Simulated Chain Activity Log
   Fake 10 BPS BlockDAG block feed + covenant tx flashes
   ============================================================ */

const Chain = {
  _feed: null,
  _daa: 48000000 + Math.floor(Math.random() * 100000),
  _interval: null,
  _maxEntries: 60,

  init() {
    this._feed = document.getElementById('chain-feed');
    if (!this._feed) return;
    // Simulate ~10 BPS with slight jitter
    this._interval = setInterval(() => this._addBlock(), 100 + Math.random() * 50);
  },

  _randomHash() {
    const hex = '0123456789abcdef';
    let h = '';
    for (let i = 0; i < 64; i++) h += hex[Math.floor(Math.random() * 16)];
    return h;
  },

  _addBlock() {
    this._daa++;
    const hash = this._randomHash();
    const txCount = Math.floor(Math.random() * 8);
    const parents = 1 + Math.floor(Math.random() * 4);
    const now = new Date();
    const time = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');

    const el = document.createElement('div');
    el.className = 'chain-entry';
    el.innerHTML =
      `<span class="ce-time">${time}</span> ` +
      `BLK <span class="ce-hash">${hash.slice(0, 12)}...</span> ` +
      `<span class="ce-txs">${txCount} tx</span> ` +
      `<span class="ce-parents">${parents}p</span> ` +
      `DAA:${this._daa}`;

    this._feed.appendChild(el);
    this._trimFeed();
    this._feed.scrollTop = this._feed.scrollHeight;
  },

  // Flash a simulated covenant transaction tied to a game action
  emitCovenantTx(action, detail) {
    if (!this._feed) return;

    const now = new Date();
    const time = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    const txHash = this._randomHash();

    const el = document.createElement('div');
    el.className = 'chain-entry covenant-tx';
    el.innerHTML =
      `<span class="ce-time">${time}</span> ` +
      `<span class="ce-label">COV TX</span> ` +
      `<span class="ce-hash">${txHash.slice(0, 10)}...</span> ` +
      `<span class="ce-label">${action}</span><br>` +
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

// Boot chain log
document.addEventListener('DOMContentLoaded', () => Chain.init());
