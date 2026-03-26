/* ============================================================
   DAGKnight BBS — Engine
   Terminal renderer, typewriter, input handling
   ============================================================ */

const E = {
  _output: null,
  _input: null,
  _field: null,
  _typeSpeed: 8,

  init() {
    this._output = document.getElementById('terminal-output');
    this._input = document.getElementById('terminal-input');
    this._field = document.getElementById('input-field');
    Wallet.init();
    screenTitle();
  },

  clear() {
    this._output.innerHTML = '';
  },

  _append(html) {
    this._output.insertAdjacentHTML('beforeend', html);
    this._output.scrollTop = this._output.scrollHeight;
  },

  line(text) {
    this._append(`<span class="line t-green">${esc(text)}</span>\n`);
  },

  gold(text) {
    this._append(`<span class="line t-gold">${esc(text)}</span>\n`);
  },

  red(text) {
    this._append(`<span class="line t-red">${esc(text)}</span>\n`);
  },

  cyan(text) {
    this._append(`<span class="line t-cyan">${esc(text)}</span>\n`);
  },

  dim(text) {
    this._append(`<span class="line t-dim">${esc(text)}</span>\n`);
  },

  blank() {
    this._append('<span class="line">&nbsp;</span>\n');
  },

  ascii(text) {
    this._append(`<span class="line-ascii">${esc(text)}</span>\n`);
  },

  // Show numbered menu, return selected key
  menu(options) {
    return new Promise(resolve => {
      this.blank();
      options.forEach(opt => {
        this._append(
          `<span class="menu-option" data-key="${opt.key}">` +
          `  <span class="menu-key">[${opt.key}]</span> ${esc(opt.label)}` +
          `</span>\n`
        );
      });
      this.blank();
      this._output.scrollTop = this._output.scrollHeight;

      const validKeys = options.map(o => o.key.toUpperCase());

      // Click handler
      const clickHandler = (e) => {
        const el = e.target.closest('.menu-option');
        if (el && el.dataset.key) {
          cleanup();
          resolve(el.dataset.key.toUpperCase());
        }
      };

      // Key handler
      const keyHandler = (e) => {
        const k = e.key.toUpperCase();
        if (validKeys.includes(k)) {
          e.preventDefault();
          cleanup();
          resolve(k);
        }
      };

      const cleanup = () => {
        document.removeEventListener('keydown', keyHandler);
        this._output.removeEventListener('click', clickHandler);
      };

      document.addEventListener('keydown', keyHandler);
      this._output.addEventListener('click', clickHandler);
    });
  },

  // Text input prompt
  prompt(label) {
    return new Promise(resolve => {
      this._append(`<span class="line t-gold">${esc(label)}</span>`);
      this._input.classList.remove('hidden');
      this._field.value = '';
      this._field.focus();

      const handler = (e) => {
        if (e.key === 'Enter') {
          const val = this._field.value;
          this._field.removeEventListener('keydown', handler);
          this._input.classList.add('hidden');
          this._append(`<span class="line t-green">${esc(val)}</span>\n`);
          resolve(val);
        }
      };

      this._field.addEventListener('keydown', handler);
    });
  },

  // "Press any key to continue"
  pause() {
    return new Promise(resolve => {
      this.dim('  [Press any key to continue]');
      this._output.scrollTop = this._output.scrollHeight;

      const handler = (e) => {
        document.removeEventListener('keydown', handler);
        this._output.removeEventListener('click', clickPause);
        resolve();
      };
      const clickPause = () => {
        document.removeEventListener('keydown', handler);
        this._output.removeEventListener('click', clickPause);
        resolve();
      };

      document.addEventListener('keydown', handler);
      this._output.addEventListener('click', clickPause);
    });
  },
};

// HTML escape
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Boot
document.addEventListener('DOMContentLoaded', () => E.init());
