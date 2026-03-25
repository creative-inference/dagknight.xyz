/* ============================================================
   DAGKnight BBS — Chain Activity Log
   Shows covenant tx entries only when game actions occur
   ============================================================ */

const Chain = {
  _feed: null,
  _daa: 48000000 + Math.floor(Math.random() * 100000),
  _maxEntries: 30,

  init() {
    this._feed = document.getElementById('chain-feed');
  },

  _randomHash() {
    const hex = '0123456789abcdef';
    let h = '';
    for (let i = 0; i < 64; i++) h += hex[Math.floor(Math.random() * 16)];
    return h;
  },

  _timestamp() {
    const now = new Date();
    return now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  },

  // Emit a block that "contains" the covenant tx
  _addBlock(txCount) {
    this._daa += Math.floor(Math.random() * 3) + 1;
    const hash = this._randomHash();
    const parents = 1 + Math.floor(Math.random() * 4);

    const el = document.createElement('div');
    el.className = 'chain-entry';
    el.innerHTML =
      `<span class="ce-time">${this._timestamp()}</span> ` +
      `BLK <span class="ce-hash">${hash.slice(0, 12)}...</span> ` +
      `<span class="ce-txs">${txCount} tx</span> ` +
      `<span class="ce-parents">${parents}p</span> ` +
      `DAA:${this._daa}`;

    this._feed.appendChild(el);
  },

  emitCovenantTx(action, detail) {
    if (!this._feed) return;

    // Block containing this covenant tx
    this._addBlock(1 + Math.floor(Math.random() * 4));

    // The covenant tx itself
    const txHash = this._randomHash();
    const el = document.createElement('div');
    el.className = 'chain-entry covenant-tx';
    el.innerHTML =
      `<span class="ce-time">${this._timestamp()}</span> ` +
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

document.addEventListener('DOMContentLoaded', () => Chain.init());
