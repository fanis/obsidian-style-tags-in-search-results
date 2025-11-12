// SPDX-License-Identifier: MIT
/* global require, module */
const { Plugin, PluginSettingTab, Setting, debounce } = require("obsidian");

/** Defaults */
const DEFAULT_SETTINGS = {
  wrapperClass: "search-tag",       // added alongside stable 'stisr-tag'
  hideInSearch: false,              // toggles .stisr-hide-tags on the Search leaf
  // Advanced (hidden by default)
  showAdvanced: false,              // UI only
  wrapAheadPx: 128                  // IntersectionObserver rootMargin vertical px (pre-wrap ahead of viewport)
};

/** Tag parsing */
const USE_UNICODE = true;
const TAG_CHAR = USE_UNICODE ? /[\p{L}\p{N}_/-]/u : /[A-Za-z0-9_/-]/;
const ALNUM    = USE_UNICODE ? /[\p{L}\p{N}]/u   : /[A-Za-z0-9]/;
const BOUNDARY = /[\s.,;:!?()[\]{}<>"'“”‘’]/;

/** Selectors */
const ROW_SELECTOR = ".search-result-file-match, .search-result__match, .search-result-match";
const RESULTS_SELECTOR = ".search-results-children, .search-results-info";

/** Utils */
const isTagChar  = (ch) => ch != null && TAG_CHAR.test(ch);
const isBoundary = (ch) => ch == null || BOUNDARY.test(ch);

/** row signature to avoid rework */
function sig(el) {
  const t = el.textContent || "";
  const h = (t.match(/#/g) || []).length;
  return `${t.length}|${h}`;
}

module.exports = class StyleTagsInSearchResultsPlugin extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };

    // state
    this._observers = [];
    this._rowSig = new WeakMap();
    this._processingRoots = new WeakSet();
    this._rowQueue = new Set();
    this._rafId = null;
    this._io = null;

    // settings UI
    this.addSettingTab(new StyleTagsInSearchResultsSettingTab(this.app, this));

    this.register(() => this._detachAllObservers());
    this.register(() => { if (this._io) { try { this._io.disconnect(); } catch(_){} this._io = null; } });
    this.register(() => { if (this._rafId) cancelAnimationFrame(this._rafId); });

    // Bind now and on layout changes
    this._bindToSearchLeaves(true);
    this.registerEvent(this.app.workspace.on("layout-change", () => this._bindToSearchLeaves(false)));

    // Keep hide state applied
    this._applyHideStateToLeaves();
  }

  onunload() {
    this._detachAllObservers();
    if (this._io) { try { this._io.disconnect(); } catch(_){} this._io = null; }
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._revertAllSearchLeaves();
    this._clearAllHideClasses();
  }

  _saveSettings = debounce(async () => { await this.saveData(this.settings); }, 120);

  /** Attach observers, per Search leaf */
  _bindToSearchLeaves(forceFullScan) {
    this._detachAllObservers();
    if (this._io) { try { this._io.disconnect(); } catch(_){} this._io = null; }

    const leaves = this.app.workspace.getLeavesOfType("search");
    if (!leaves?.length) return;

    // IntersectionObserver to catch rows revealed during scroll/virtualization
    const rootMarginPx = Math.max(0, Number(this.settings.wrapAheadPx) || DEFAULT_SETTINGS.wrapAheadPx);
    this._io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const row = e.target;
        if (!(row instanceof HTMLElement)) continue;
        // Immediate wrap if hide is ON (minimize flash), else batch to next frame
        if (this.settings.hideInSearch) this._processRow(row, false);
        else this._queueRow(row);
      }
    }, { root: null, rootMargin: `${rootMarginPx}px 0px`, threshold: 0 });

    for (const leaf of leaves) {
      const leafRoot = leaf.view?.containerEl || leaf.containerEl;
      if (!leafRoot) continue;
      const leafEl = leafRoot.closest('.workspace-leaf-content[data-type="search"]') || leafRoot;

      // Apply hide state at leaf level
      this._applyHideClass(leafEl, this.settings.hideInSearch);

      // Initial pass
      const resultsRoot =
        leafEl.querySelector(".search-results-children") ||
        leafEl.querySelector(".search-results-info") ||
        null;
      if (resultsRoot) this._scanRoot(resultsRoot, !!forceFullScan);

      // Unified observer: handles both container swaps and individual row additions
      const containerObserver = new MutationObserver((muts) => {
        let swapped = false;

        // First pass: check if container swapped
        for (const m of muts) {
          if (m.type !== "childList") continue;
          for (const n of m.addedNodes) {
            if (!(n instanceof HTMLElement)) continue;
            if (n.matches?.(RESULTS_SELECTOR) || n.querySelector?.(RESULTS_SELECTOR)) {
              swapped = true;
              break;
            }
          }
          if (swapped) break;
        }

        if (swapped) {
          // Container swapped - full scan
          const cur =
            leafEl.querySelector(".search-results-children") ||
            leafEl.querySelector(".search-results-info");
          if (cur) {
            this._applyHideClass(leafEl, this.settings.hideInSearch);
            this._scanRoot(cur, true);
          }
        } else {
          // No swap - process individual row additions
          for (const m of muts) {
            if (m.type !== "childList") continue;
            for (const n of m.addedNodes) {
              if (!(n instanceof HTMLElement)) continue;
              if (n.matches?.(ROW_SELECTOR)) {
                if (this.settings.hideInSearch) this._processRow(n, false);
                else this._queueRow(n);
                this._io.observe(n);
              }
              n.querySelectorAll?.(ROW_SELECTOR).forEach((row) => {
                if (this.settings.hideInSearch) this._processRow(row, false);
                else this._queueRow(row);
                this._io.observe(row);
              });
            }
          }
        }
      });
      containerObserver.observe(leafEl, { subtree: true, childList: true });
      this._observers.push(containerObserver);
    }
  }

  _detachAllObservers() {
    for (const o of this._observers) { try { o.disconnect(); } catch (_) {} }
    this._observers.length = 0;
  }

  /** Batch queue: process at most once per frame */
  _queueRow(row) {
    if (!(row instanceof HTMLElement)) return;
    if (!row.matches(ROW_SELECTOR)) return;
    this._rowQueue.add(row);
    if (this._rafId == null) {
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        const rows = Array.from(this._rowQueue);
        this._rowQueue.clear();
        for (const r of rows) if (r.isConnected) this._processRow(r, false);
      });
    }
  }

  /** Full container scan (idempotent; guarded) */
  _scanRoot(root, force = false) {
    if (!root || !root.querySelectorAll) return;
    if (this._processingRoots.has(root)) return;
    this._processingRoots.add(root);
    try {
      const rows = root.querySelectorAll(ROW_SELECTOR);
      rows.forEach((row) => {
        // Observe for viewport triggers
        try { this._io && this._io.observe(row); } catch(_) {}
        // Immediate when hide is on (minimize flash), else queue to next frame
        if (this.settings.hideInSearch) this._processRow(row, force);
        else this._queueRow(row);
      });
    } finally {
      this._processingRoots.delete(root);
    }
  }

  /** Process a single result row (micro-opt + signature check) */
  _processRow(row, force = false) {
    // MICRO-OPT: if we've already wrapped this row and it no longer contains '#', skip fast
    if (!force && row.dataset.stisr === "1" && !(row.textContent || "").includes("#")) return;

    const textPeek = row.textContent || "";
    if (!textPeek.includes("#")) {
      // reset flag/signature so future changes are noticed
      delete row.dataset.stisr;
      this._rowSig.delete(row);
      return;
    }

    const curSig = sig(row);
    const lastSig = this._rowSig.get(row);
    if (!force && lastSig === curSig) return; // nothing changed, skip

    // unwrap previous wraps (ours + legacy) if present
    const hasCurrent = !!row.querySelector(".stisr-tag");
    const hasLegacy  = !!row.querySelector(".search-tag");
    if (force || hasLegacy || hasCurrent) {
      row.querySelectorAll(".stisr-tag, .search-tag").forEach((s) => {
        const p = s.parentNode; if (!p) return;
        while (s.firstChild) p.insertBefore(s.firstChild, s);
        p.removeChild(s);
      });
    }

    this._wrapAllTags(row);
    this._cleanupMatchedTextEmpties(row);

    // remember signature after processing + set processed flag
    this._rowSig.set(row, sig(row));
    row.dataset.stisr = "1";
  }

  /** One-pass wrapper */
  _wrapAllTags(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const collected = [];

    for (let tn; (tn = walker.nextNode()); ) {
      if (!tn.nodeValue) continue;
      if (tn.parentElement && tn.parentElement.closest(".stisr-tag, .search-tag")) continue;

      const text = tn.nodeValue;
      let j = 0;

      while (true) {
        const hashPos = text.indexOf("#", j);
        if (hashPos === -1) break;

        const beforeCh = hashPos > 0 ? text[hashPos - 1] : this._prevTextChar(root, tn);
        if (!isBoundary(beforeCh)) { j = hashPos + 1; continue; }

        let startNode = tn, startOffset = hashPos;
        let endNode = tn, endOffset = hashPos + 1, seenAlnum = false;

        ({ endOffset, seenAlnum } = this._eatInNode(endNode, endOffset, seenAlnum));

        while (endOffset >= (endNode.nodeValue || "").length) {
          const next = this._nextTextNode(root, endNode);
          if (!next) break;
          const first = (next.nodeValue || "")[0];
          if (!isTagChar(first)) break;
          endNode = next;
          endOffset = 0;
          ({ endOffset, seenAlnum } = this._eatInNode(endNode, endOffset, seenAlnum));
        }

        const afterCh =
          endOffset < (endNode.nodeValue || "").length
            ? (endNode.nodeValue || "")[endOffset]
            : this._nextTextChar(root, endNode);

        if (!seenAlnum || !isBoundary(afterCh)) { j = hashPos + 1; continue; }

        collected.push({ startNode, startOffset, endNode, endOffset });
        j = hashPos + 1;
      }
    }

    const userCls = this.settings.wrapperClass || DEFAULT_SETTINGS.wrapperClass;
    for (let i = collected.length - 1; i >= 0; i--) {
      const r = collected[i];
      try {
        const range = document.createRange();
        range.setStart(r.startNode, r.startOffset);
        range.setEnd(r.endNode, r.endOffset);

        const wrap = document.createElement("span");
        wrap.className = `stisr-tag ${userCls}`;

        try { range.surroundContents(wrap); }
        catch {
          const frag = range.extractContents();
          wrap.appendChild(frag);
          range.insertNode(wrap);
        }
      } catch { /* ignore transient */ }
    }
    return collected.length > 0;
  }

  /** Targeted cleanup: remove empty highlight spans created by Search */
  _cleanupMatchedTextEmpties(root) {
    root.querySelectorAll(".search-result-file-matched-text").forEach((el) => {
      if (!el.firstChild || (el.textContent || "").length === 0) el.remove();
    });
  }

  _eatInNode(node, offset, seenAlnum) {
    const s = node.nodeValue || "";
    let i = offset, seen = !!seenAlnum;
    while (i < s.length) {
      const ch = s[i];
      if (!isTagChar(ch)) break;
      if (!seen && ALNUM.test(ch)) seen = true;
      i++;
    }
    return { endOffset: i, seenAlnum: seen };
  }

  _nextTextNode(root, node) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n === node) break;
    return w.nextNode();
  }

  _prevTextChar(root, node) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) texts.push(n);
    const idx = texts.indexOf(node);
    if (idx <= 0) return null;
    for (let k = idx - 1; k >= 0; k--) {
      const s = texts[k].nodeValue || "";
      if (s.length > 0) return s[s.length - 1];
    }
    return null;
  }

  _nextTextChar(root, node) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) texts.push(n);
    const idx = texts.indexOf(node);
    if (idx === -1) return null;
    for (let k = idx + 1; k < texts.length; k++) {
      const s = texts[k].nodeValue || "";
      if (s.length > 0) return s[0];
    }
    return null;
  }

  /** ---------- Hide via class ---------- */
  _applyHideClass(leafEl, shouldHide) {
    if (!(leafEl instanceof HTMLElement)) return;
    leafEl.classList.toggle("stisr-hide-tags", !!shouldHide);
  }

  _applyHideStateToLeaves() {
    const leaves = this.app.workspace.getLeavesOfType("search");
    if (!leaves?.length) return;
    for (const leaf of leaves) {
      const leafRoot = leaf.view?.containerEl || leaf.containerEl;
      if (!leafRoot) continue;
      const leafEl = leafRoot.closest('.workspace-leaf-content[data-type="search"]') || leafRoot;
      this._applyHideClass(leafEl, this.settings.hideInSearch);
    }
    if (!this.settings.hideInSearch) this._clearAllHideClasses();
  }

  _clearAllHideClasses() {
    document
      .querySelectorAll('.workspace-leaf-content[data-type="search"].stisr-hide-tags')
      .forEach((el) => el.classList.remove("stisr-hide-tags"));
  }

  /** ---------- Revert on disable ---------- */
  _revertAllSearchLeaves() {
    const leaves = this.app.workspace.getLeavesOfType("search");
    if (!leaves?.length) return;
    for (const leaf of leaves) {
      const leafRoot = leaf.view?.containerEl || leaf.containerEl;
      if (!leafRoot) continue;
      const leafEl = leafRoot.closest('.workspace-leaf-content[data-type="search"]') || leafRoot;

      const resultsRoots = leafEl.querySelectorAll(RESULTS_SELECTOR);
      resultsRoots.forEach((resultsRoot) => {
        resultsRoot.querySelectorAll(".stisr-tag, .search-tag").forEach((s) => {
          const p = s.parentNode; if (!p) return;
          while (s.firstChild) p.insertBefore(s.firstChild, s);
          p.removeChild(s);
        });
        this._cleanupMatchedTextEmpties(resultsRoot);
      });

      this._applyHideClass(leafEl, false);
    }
    this._clearAllHideClasses();
  }

  /** Force a rescan across all Search panes (used after tag clicks / input burst) */
  _rescanAllSearchPanes(force = false) {
    const leaves = this.app.workspace.getLeavesOfType("search");
    if (!leaves?.length) return;
    for (const leaf of leaves) {
      const leafRoot = leaf.view?.containerEl || leaf.containerEl;
      if (!leafRoot) continue;
      const leafEl = leafRoot.closest('.workspace-leaf-content[data-type="search"]') || leafRoot;
      this._applyHideClass(leafEl, this.settings.hideInSearch);
      const resultsRoot =
        leafEl.querySelector(".search-results-children") ||
        leafEl.querySelector(".search-results-info");
      if (resultsRoot) this._scanRoot(resultsRoot, !!force);
    }
  }
};

/** Settings tab (no headings, per guidelines) */
class StyleTagsInSearchResultsSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    // Wrapper CSS class
    new Setting(containerEl)
      .setName("Wrapper CSS class")
      .setDesc("Added to wrapped hashtags alongside the stable 'stisr-tag'. Style via CSS/snippets.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.wrapperClass)
          .setValue(this.plugin.settings.wrapperClass)
          .onChange(async (value) => {
            this.plugin.settings.wrapperClass =
              (value || "").trim() || DEFAULT_SETTINGS.wrapperClass;
            this.plugin._saveSettings();
            this.plugin._bindToSearchLeaves(true); // rebind + rescan with new class
          })
      );

    // Hide toggle
    new Setting(containerEl)
      .setName("Hide wrapped hashtags in Search")
      .setDesc("Toggles a CSS class on the Search leaf; themes/snippets control visibility.")
      .addToggle((toggle) =>
        toggle
          .setValue(!!this.plugin.settings.hideInSearch)
          .onChange(async (val) => {
            this.plugin.settings.hideInSearch = !!val;
            this.plugin._saveSettings();
            this.plugin._applyHideStateToLeaves();  // immediate
            this.plugin._bindToSearchLeaves(false); // keep watchers in sync
          })
      );

    // Advanced (hidden by default)
    new Setting(containerEl)
      .setName("Advanced options")
      .setDesc("Performance tuning for large result sets.")
      .addToggle((toggle) =>
        toggle
          .setValue(!!this.plugin.settings.showAdvanced)
          .onChange(async (val) => {
            this.plugin.settings.showAdvanced = !!val;
            this.plugin._saveSettings();
            this.display(); // re-render to show/hide controls
          })
      );

    if (this.plugin.settings.showAdvanced) {
      // Wrap ahead (IO rootMargin)
      new Setting(containerEl)
        .setName("Wrap ahead (px)")
        .setDesc("Pre-wrap rows before they enter the viewport. Increase to reduce flicker while scrolling fast.")
        .addText((text) =>
          text
            .setPlaceholder(String(DEFAULT_SETTINGS.wrapAheadPx))
            .setValue(String(this.plugin.settings.wrapAheadPx ?? DEFAULT_SETTINGS.wrapAheadPx))
            .onChange(async (v) => {
              const n = Math.max(0, Number(v) || DEFAULT_SETTINGS.wrapAheadPx);
              this.plugin.settings.wrapAheadPx = n;
              this.plugin._saveSettings();
              this.plugin._bindToSearchLeaves(false); // rebuild IO with new margin
            })
        );
    }
  }
}
