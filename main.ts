// SPDX-License-Identifier: MIT
import { App, Plugin, PluginSettingTab, Setting, debounce, Debouncer } from "obsidian";

/** Defaults */
interface StisrSettings {
  wrapperClass: string;
  hideInSearch: boolean;
  showAdvanced: boolean;
  wrapAheadPx: number;
}

const DEFAULT_SETTINGS: StisrSettings = {
  wrapperClass: "search-tag", // added alongside stable 'stisr-tag'
  hideInSearch: false, // toggles .stisr-hide-tags on the Search leaf
  // Advanced (hidden by default)
  showAdvanced: false, // UI only
  wrapAheadPx: 128, // IntersectionObserver rootMargin vertical px (pre-wrap ahead of viewport)
};

/** Tag parsing */
const TAG_CHAR = /[\p{L}\p{N}_/-]/u;
const ALNUM = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;
// Obsidian's tag parser rejects leading '-' and '/' after '#'. Require the
// first char after '#' to be a letter, digit, or underscore.
const FIRST_TAG_CHAR = /[\p{L}\p{N}_]/u;
const BOUNDARY = /[\s.,;:!?()[\]{}<>"'“”‘’]/;

/** Selectors */
const ROW_SELECTOR = ".search-result-file-match, .search-result__match, .search-result-match";
const RESULTS_SELECTOR = ".search-results-children, .search-results-info";

/** Utils */
const isTagChar = (ch: string | null | undefined): boolean => ch != null && TAG_CHAR.test(ch);
const isBoundary = (ch: string | null | undefined): boolean => ch == null || BOUNDARY.test(ch);

interface TagRange {
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
}

interface EatResult {
  endOffset: number;
  seenAlnum: boolean;
  seenNonDigit: boolean;
}

// Probabilistic row signature: length + '#' count. Skips re-processing when
// neither changed. Safe because Obsidian's Search re-renders rows on query
// changes rather than mutating text nodes in place — the collision case
// (same length + same '#' count but different content) doesn't occur there.
function sig(text: string): string {
  let h = 0;
  for (let i = text.indexOf("#"); i !== -1; i = text.indexOf("#", i + 1)) {
    h++;
  }
  return `${text.length}|${h}`;
}

/** Replace a wrapper element with its children (undo a wrap). */
function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes));
}

/** Parse a non-negative px value; fall back to the default on anything else. */
export function parseWrapAheadPx(value: unknown): number {
  const n = typeof value === "string" ? Number(value.trim() || NaN) : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.wrapAheadPx;
}

function eatInNode(
  node: Text,
  offset: number,
  seenAlnum: boolean,
  seenNonDigit: boolean,
): EatResult {
  const s = node.nodeValue || "";
  let i = offset,
    seenA = seenAlnum,
    seenND = seenNonDigit;
  while (i < s.length) {
    const ch = s[i];
    if (!isTagChar(ch)) {
      break;
    }
    if (!seenA && ALNUM.test(ch)) {
      seenA = true;
    }
    if (!seenND && !DIGIT.test(ch)) {
      seenND = true;
    }
    i++;
  }
  return { endOffset: i, seenAlnum: seenA, seenNonDigit: seenND };
}

function getPrevChar(textNodes: Text[], idx: number): string | null {
  for (let k = idx - 1; k >= 0; k--) {
    const s = textNodes[k].nodeValue || "";
    if (s.length > 0) {
      return s[s.length - 1];
    }
  }
  return null;
}

function getNextChar(textNodes: Text[], idx: number): string | null {
  for (let k = idx + 1; k < textNodes.length; k++) {
    const s = textNodes[k].nodeValue || "";
    if (s.length > 0) {
      return s[0];
    }
  }
  return null;
}

/**
 * Pure tag detection: given an array of text nodes, return DOM ranges
 * covering each tag occurrence. A range may span multiple text nodes
 * (e.g. when search highlighting splits "#foobar" into "#foo" + "bar").
 */
export function collectTagRanges(textNodes: Text[]): TagRange[] {
  const collected: TagRange[] = [];

  for (let i = 0; i < textNodes.length; i++) {
    const tn = textNodes[i];
    if (!tn.nodeValue) {
      continue;
    }
    if (tn.parentElement && tn.parentElement.closest(".stisr-tag, .search-tag")) {
      continue;
    }

    const text = tn.nodeValue;
    let j = 0;

    while (true) {
      const hashPos = text.indexOf("#", j);
      if (hashPos === -1) {
        break;
      }

      const beforeCh = hashPos > 0 ? text[hashPos - 1] : getPrevChar(textNodes, i);
      if (!isBoundary(beforeCh)) {
        j = hashPos + 1;
        continue;
      }

      const firstAfterHash =
        hashPos + 1 < text.length ? text[hashPos + 1] : getNextChar(textNodes, i);
      if (!firstAfterHash || !FIRST_TAG_CHAR.test(firstAfterHash)) {
        j = hashPos + 1;
        continue;
      }

      const startNode = tn,
        startOffset = hashPos;
      let endNode = tn,
        endOffset = hashPos + 1,
        seenAlnum = false,
        seenNonDigit = false;
      let endIdx = i;

      ({ endOffset, seenAlnum, seenNonDigit } = eatInNode(
        endNode,
        endOffset,
        seenAlnum,
        seenNonDigit,
      ));

      while (endOffset >= (endNode.nodeValue || "").length) {
        const nextIdx = endIdx + 1;
        if (nextIdx >= textNodes.length) {
          break;
        }
        const next = textNodes[nextIdx];
        const nextText = next.nodeValue || "";
        // Skip empty text nodes; only a non-tag first char stops the extension.
        if (nextText.length > 0 && !isTagChar(nextText[0])) {
          break;
        }
        endNode = next;
        endIdx = nextIdx;
        endOffset = 0;
        ({ endOffset, seenAlnum, seenNonDigit } = eatInNode(
          endNode,
          endOffset,
          seenAlnum,
          seenNonDigit,
        ));
      }

      const afterCh =
        endOffset < (endNode.nodeValue || "").length
          ? (endNode.nodeValue || "")[endOffset]
          : getNextChar(textNodes, endIdx);

      // Obsidian's rule: tag body must contain at least one non-numerical character.
      if (!seenAlnum || !seenNonDigit || !isBoundary(afterCh)) {
        j = hashPos + 1;
        continue;
      }

      collected.push({ startNode, startOffset, endNode, endOffset });
      j = hashPos + 1;
    }
  }

  return collected;
}

/** Mutate the DOM: wrap each range with a <span class="stisr-tag {wrapperClass}">. */
export function wrapRanges(ranges: TagRange[], wrapperClass: string): void {
  const userCls = wrapperClass || DEFAULT_SETTINGS.wrapperClass;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    // Wrap in the document the nodes actually live in, not the global one.
    const doc = r.startNode.ownerDocument;
    if (!doc) {
      continue;
    }
    try {
      const range = doc.createRange();
      range.setStart(r.startNode, r.startOffset);
      range.setEnd(r.endNode, r.endOffset);

      const wrap = doc.createElement("span");
      wrap.className = `stisr-tag ${userCls}`;

      try {
        range.surroundContents(wrap);
      } catch {
        const frag = range.extractContents();
        wrap.appendChild(frag);
        range.insertNode(wrap);
      }
    } catch {
      /* transient DOM state during fast scroll */
    }
  }
}

export default class StyleTagsInSearchResultsPlugin extends Plugin {
  settings: StisrSettings = { ...DEFAULT_SETTINGS };

  // state
  _observers: MutationObserver[] = [];
  _rowSig: WeakMap<Element, string> = new WeakMap();
  _rowQueue: Set<HTMLElement> = new Set();
  _rafId: number | null = null;
  _io: IntersectionObserver | null = null;

  _saveSettings: Debouncer<[], Promise<void>> = debounce(
    async () => {
      await this.saveData(this.settings);
    },
    120,
    true,
  );

  // Settings text fields fire onChange per keystroke; rebinding tears down and
  // rebuilds every observer plus a full rescan, so coalesce bursts. A forced
  // rebind wins over a plain one within the same burst.
  _rebindForcePending = false;
  _rebindSoon: Debouncer<[boolean], void> = debounce(
    (force: boolean) => {
      const doForce = force || this._rebindForcePending;
      this._rebindForcePending = false;
      this._bindToSearchLeaves(doForce);
    },
    250,
    true,
  );

  _requestRebind(force: boolean): void {
    if (force) {
      this._rebindForcePending = true;
    }
    this._rebindSoon(force);
  }

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<StisrSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved };

    // settings UI
    this.addSettingTab(new StyleTagsInSearchResultsSettingTab(this.app, this));

    this.register(() => this._detachAllObservers());
    this.register(() => {
      if (this._io) {
        this._io.disconnect();
        this._io = null;
      }
    });
    this.register(() => this._cancelQueuedWork());

    // Bind now and on layout changes
    this._bindToSearchLeaves(true);
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this._bindToSearchLeaves(false)),
    );

    // Keep hide state applied
    this._applyHideStateToLeaves();
  }

  // Obsidian doesn't await onunload(), so flushing the debounced settings save
  // here can't *block* teardown — but `run()` invokes the pending save
  // synchronously, so the in-flight saveData() still drains on the microtask
  // queue when the plugin is disabled (vs. full app exit, where neither form
  // can guarantee the write lands).
  onunload(): void {
    void this._saveSettings.run();
    this._rebindSoon.cancel();
    this._detachAllObservers();
    if (this._io) {
      this._io.disconnect();
      this._io = null;
    }
    this._cancelQueuedWork();
    this._revertAllSearchLeaves();
  }

  _cancelQueuedWork(): void {
    if (this._rafId != null) {
      window.cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._rowQueue.clear();
  }

  /** Resolve the leaf-content element for every open Search leaf. */
  _getSearchLeafEls(): Element[] {
    const els: Element[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("search")) {
      const leafRoot = leaf.view?.containerEl;
      if (!leafRoot) {
        continue;
      }
      els.push(leafRoot.closest('.workspace-leaf-content[data-type="search"]') || leafRoot);
    }
    return els;
  }

  /** Wrap immediately when hiding (minimize flash), else batch to next frame. */
  _enqueueOrProcess(row: Element): void {
    if (this.settings.hideInSearch) {
      this._processRow(row, false);
    } else {
      this._queueRow(row);
    }
  }

  /** Attach observers, per Search leaf */
  _bindToSearchLeaves(forceFullScan: boolean): void {
    this._detachAllObservers();
    if (this._io) {
      this._io.disconnect();
      this._io = null;
    }

    const leafEls = this._getSearchLeafEls();
    if (!leafEls.length) {
      return;
    }

    // IntersectionObserver to catch rows revealed during scroll/virtualization
    const rootMarginPx = parseWrapAheadPx(this.settings.wrapAheadPx);
    this._io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) {
            continue;
          }
          const row = e.target;
          if (!row.instanceOf(HTMLElement)) {
            continue;
          }
          this._enqueueOrProcess(row);
        }
      },
      { root: null, rootMargin: `${rootMarginPx}px 0px`, threshold: 0 },
    );

    for (const leafEl of leafEls) {
      // Apply hide state at leaf level
      this._applyHideClass(leafEl, this.settings.hideInSearch);

      // Initial pass
      const resultsRoot = leafEl.querySelector(RESULTS_SELECTOR);
      if (resultsRoot) {
        this._scanRoot(resultsRoot, forceFullScan);
      }

      // Unified observer: handles both container swaps and individual row additions
      const containerObserver = new MutationObserver((muts) => {
        let swapped = false;

        // First pass: check if container swapped
        for (const m of muts) {
          if (m.type !== "childList") {
            continue;
          }
          for (const n of m.addedNodes) {
            if (!n.instanceOf(HTMLElement)) {
              continue;
            }
            if (n.matches(RESULTS_SELECTOR) || n.querySelector(RESULTS_SELECTOR)) {
              swapped = true;
              break;
            }
          }
          if (swapped) {
            break;
          }
        }

        if (swapped) {
          // Container swapped - full scan
          const cur = leafEl.querySelector(RESULTS_SELECTOR);
          if (cur) {
            this._scanRoot(cur, true);
          }
        } else {
          // No swap - process individual row additions
          for (const m of muts) {
            if (m.type !== "childList") {
              continue;
            }
            for (const n of m.addedNodes) {
              if (!n.instanceOf(HTMLElement)) {
                continue;
              }
              if (n.matches(ROW_SELECTOR)) {
                this._enqueueOrProcess(n);
                this._io?.observe(n);
              }
              n.querySelectorAll(ROW_SELECTOR).forEach((row) => {
                this._enqueueOrProcess(row);
                this._io?.observe(row);
              });
            }
          }
        }
      });
      containerObserver.observe(leafEl, { subtree: true, childList: true });
      this._observers.push(containerObserver);
    }
  }

  _detachAllObservers(): void {
    for (const o of this._observers) {
      o.disconnect();
    }
    this._observers.length = 0;
  }

  /** Batch queue: process at most once per frame */
  _queueRow(row: Element): void {
    if (!row.instanceOf(HTMLElement)) {
      return;
    }
    if (!row.matches(ROW_SELECTOR)) {
      return;
    }
    this._rowQueue.add(row);
    if (this._rafId == null) {
      this._rafId = window.requestAnimationFrame(() => {
        this._rafId = null;
        const rows = Array.from(this._rowQueue);
        this._rowQueue.clear();
        for (const r of rows) {
          if (r.isConnected) {
            this._processRow(r, false);
          }
        }
      });
    }
  }

  /** Full container scan (idempotent) */
  _scanRoot(root: Element, force = false): void {
    root.querySelectorAll(ROW_SELECTOR).forEach((row) => {
      // Observe for viewport triggers
      this._io?.observe(row);
      // Forced scans must bypass the signature check, so never route them
      // through the queue (which always processes with force=false).
      if (force || this.settings.hideInSearch) {
        this._processRow(row, force);
      } else {
        this._queueRow(row);
      }
    });
  }

  /** Process a single result row (micro-opt + signature check) */
  _processRow(row: Element, force = false): void {
    if (!row.instanceOf(HTMLElement)) {
      return;
    }
    const textPeek = row.textContent || "";

    //if we've already wrapped this row and it no longer contains '#', skip fast
    if (!force && row.dataset.stisr === "1" && !textPeek.includes("#")) {
      return;
    }

    if (!textPeek.includes("#")) {
      // reset flag/signature so future changes are noticed
      row.removeAttribute("data-stisr");
      this._rowSig.delete(row);
      return;
    }

    const curSig = sig(textPeek);
    const lastSig = this._rowSig.get(row);
    if (!force && lastSig === curSig) {
      return;
    } // nothing changed, skip

    // unwrap previous wraps (ours + legacy) if present
    row.querySelectorAll(".stisr-tag, .search-tag").forEach(unwrap);

    this._wrapAllTags(row);
    this._cleanupMatchedTextEmpties(row);

    // remember signature after processing + set processed flag
    this._rowSig.set(row, curSig);
    row.dataset.stisr = "1";
  }

  /** One-pass wrapper */
  _wrapAllTags(root: Element): void {
    const doc = root.ownerDocument;
    if (!doc) {
      return;
    }
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let tn = walker.nextNode(); tn; tn = walker.nextNode()) {
      textNodes.push(tn as Text);
    }

    const ranges = collectTagRanges(textNodes);
    wrapRanges(ranges, this.settings.wrapperClass || DEFAULT_SETTINGS.wrapperClass);
  }

  /** Targeted cleanup: remove empty highlight spans created by Search */
  _cleanupMatchedTextEmpties(root: Element): void {
    root.querySelectorAll(".search-result-file-matched-text").forEach((el) => {
      if (!el.firstChild || (el.textContent || "").length === 0) {
        el.remove();
      }
    });
  }

  /** ---------- Hide via class ---------- */
  _applyHideClass(leafEl: Element, shouldHide: boolean): void {
    if (!leafEl.instanceOf(HTMLElement)) {
      return;
    }
    leafEl.classList.toggle("stisr-hide-tags", shouldHide);
  }

  _applyHideStateToLeaves(): void {
    for (const leafEl of this._getSearchLeafEls()) {
      this._applyHideClass(leafEl, this.settings.hideInSearch);
    }
  }

  /** ---------- Revert on disable ---------- */
  _revertAllSearchLeaves(): void {
    for (const leafEl of this._getSearchLeafEls()) {
      leafEl.querySelectorAll(RESULTS_SELECTOR).forEach((resultsRoot) => {
        resultsRoot.querySelectorAll(".stisr-tag, .search-tag").forEach(unwrap);
        this._cleanupMatchedTextEmpties(resultsRoot);
      });
      this._applyHideClass(leafEl, false);
    }
  }
}

/** Settings tab (no headings, per guidelines) */
class StyleTagsInSearchResultsSettingTab extends PluginSettingTab {
  plugin: StyleTagsInSearchResultsPlugin;

  constructor(app: App, plugin: StyleTagsInSearchResultsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Wrapper CSS class
    new Setting(containerEl)
      .setName("Wrapper CSS class")
      .setDesc(
        "Added to wrapped hashtags alongside the stable 'stisr-tag'. Style via CSS/snippets.",
      )
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.wrapperClass)
          .setValue(this.plugin.settings.wrapperClass)
          .onChange((value) => {
            this.plugin.settings.wrapperClass =
              (value || "").trim() || DEFAULT_SETTINGS.wrapperClass;
            this.plugin._saveSettings();
            this.plugin._requestRebind(true); // rebind + rescan with new class
          }),
      );

    // Hide toggle
    new Setting(containerEl)
      .setName("Hide wrapped hashtags in search")
      .setDesc("Toggles a CSS class on the search leaf; themes/snippets control visibility.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideInSearch).onChange((val) => {
          this.plugin.settings.hideInSearch = val;
          this.plugin._saveSettings();
          this.plugin._applyHideStateToLeaves(); // immediate
          this.plugin._requestRebind(false); // keep watchers in sync
        }),
      );

    // Advanced (hidden by default)
    new Setting(containerEl)
      .setName("Advanced options")
      .setDesc("Performance tuning for large result sets.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showAdvanced).onChange((val) => {
          this.plugin.settings.showAdvanced = val;
          this.plugin._saveSettings();
          this.display(); // re-render to show/hide controls
        }),
      );

    if (this.plugin.settings.showAdvanced) {
      // Wrap ahead (IO rootMargin)
      new Setting(containerEl)
        .setName("Wrap ahead (px)")
        .setDesc(
          "Pre-wrap rows before they enter the viewport. Increase to reduce flicker while scrolling fast.",
        )
        .addText((text) =>
          text
            .setPlaceholder(String(DEFAULT_SETTINGS.wrapAheadPx))
            .setValue(String(this.plugin.settings.wrapAheadPx))
            .onChange((v) => {
              this.plugin.settings.wrapAheadPx = parseWrapAheadPx(v);
              this.plugin._saveSettings();
              this.plugin._requestRebind(false); // rebuild IO with new margin
            }),
        );
    }
  }
}
