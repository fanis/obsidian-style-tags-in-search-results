import { describe, test, expect } from "vitest";
import StyleTagsInSearchResultsPlugin, {
  collectTagRanges,
  wrapRanges,
  parseWrapAheadPx,
} from "../main.ts";

if (!Node.prototype.instanceOf) {
  Node.prototype.instanceOf = function instanceOf(type) {
    return this instanceof type;
  };
}

// happy-dom's TreeWalker with SHOW_TEXT doesn't descend into element children
// (real Chromium does). For tests we use a spec-correct manual walker so the
// behaviour of collectTagRanges across nested inline elements is verified.
function build(html) {
  const root = document.createElement("div");
  root.innerHTML = html;
  const textNodes = [];
  (function walk(node) {
    if (node.nodeType === 3) {
      textNodes.push(node);
      return;
    }
    for (const child of node.childNodes) walk(child);
  })(root);
  return { root, textNodes };
}

function rangeText(r) {
  const range = document.createRange();
  range.setStart(r.startNode, r.startOffset);
  range.setEnd(r.endNode, r.endOffset);
  return range.toString();
}

describe("collectTagRanges - basic acceptance", () => {
  test("wraps a single simple tag", () => {
    const { textNodes } = build("hello #foo bar");
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#foo");
  });

  test("wraps multiple tags in one row", () => {
    const { textNodes } = build("a #foo b #bar c");
    const ranges = collectTagRanges(textNodes);
    expect(ranges.map(rangeText)).toEqual(["#foo", "#bar"]);
  });

  test("wraps tags followed by sentence punctuation", () => {
    const { textNodes } = build("needs #review, then #done.");
    const ranges = collectTagRanges(textNodes);
    expect(ranges.map(rangeText)).toEqual(["#review", "#done"]);
  });

  test("wraps tags inside parentheses and quotes", () => {
    const { textNodes } = build('status (#waiting) and "#next"');
    const ranges = collectTagRanges(textNodes);
    expect(ranges.map(rangeText)).toEqual(["#waiting", "#next"]);
  });

  test("wraps a nested tag", () => {
    const { textNodes } = build("see #project/alpha now");
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#project/alpha");
  });

  test("wraps a deeply nested tag", () => {
    const { textNodes } = build("see #project/alpha/beta now");
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#project/alpha/beta");
  });

  test("wraps tag with internal hyphens", () => {
    const { textNodes } = build("here #a-b-c done");
    const ranges = collectTagRanges(textNodes);
    expect(rangeText(ranges[0])).toBe("#a-b-c");
  });

  test("wraps tag with underscores and digits", () => {
    const { textNodes } = build("note #project_2026 done");
    const ranges = collectTagRanges(textNodes);
    expect(rangeText(ranges[0])).toBe("#project_2026");
  });

  test("wraps tag starting with underscore", () => {
    const { textNodes } = build("note #_private here");
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#_private");
  });

  test("wraps tag at start of text", () => {
    const { textNodes } = build("#foo bar");
    const ranges = collectTagRanges(textNodes);
    expect(rangeText(ranges[0])).toBe("#foo");
  });

  test("wraps tag at end of text", () => {
    const { textNodes } = build("bar #foo");
    const ranges = collectTagRanges(textNodes);
    expect(rangeText(ranges[0])).toBe("#foo");
  });

  test("wraps tag after a newline", () => {
    const { textNodes } = build("first line\n#next line");
    const ranges = collectTagRanges(textNodes);
    expect(rangeText(ranges[0])).toBe("#next");
  });

  test("wraps unicode tag", () => {
    const { textNodes } = build("hello #ümlaut bar");
    const ranges = collectTagRanges(textNodes);
    expect(rangeText(ranges[0])).toBe("#ümlaut");
  });
});

describe("collectTagRanges - rejection", () => {
  test("rejects # with no following alnum-or-underscore (leading hyphen)", () => {
    const { textNodes } = build("a #-abc b");
    expect(collectTagRanges(textNodes)).toHaveLength(0);
  });

  test("rejects # with leading slash", () => {
    const { textNodes } = build("a #/abc b");
    expect(collectTagRanges(textNodes)).toHaveLength(0);
  });

  test("rejects multi-dash prefix", () => {
    const { textNodes } = build("a #---abc b");
    expect(collectTagRanges(textNodes)).toHaveLength(0);
  });

  test("rejects # at end of text with nothing after", () => {
    const { textNodes } = build("trailing #");
    expect(collectTagRanges(textNodes)).toHaveLength(0);
  });

  test("rejects # followed only by punctuation", () => {
    const { textNodes } = build("a #! b");
    expect(collectTagRanges(textNodes)).toHaveLength(0);
  });

  test("rejects # preceded by a non-boundary (word char)", () => {
    const { textNodes } = build("foo#bar");
    expect(collectTagRanges(textNodes)).toHaveLength(0);
  });

  test("rejects # inside a URL fragment", () => {
    const { textNodes } = build("see https://example.test/page#section");
    expect(collectTagRanges(textNodes)).toHaveLength(0);
  });

  test("rejects markdown heading markers", () => {
    const { textNodes } = build("## Heading");
    expect(collectTagRanges(textNodes)).toHaveLength(0);
  });

  test("rejects tag whose suffix char is neither tag-char nor boundary", () => {
    // '@' is not in TAG_CHAR (so eating stops at it) and not in BOUNDARY
    // (so the end-boundary check fails). Whole match is discarded.
    const { textNodes } = build("a #foo@bar b");
    expect(collectTagRanges(textNodes)).toHaveLength(0);
  });

  test("rejects pure-digit tag (#123) - must contain a non-numerical char", () => {
    const { textNodes } = build("a #123 b");
    expect(collectTagRanges(textNodes)).toHaveLength(0);
  });

  test("rejects long pure-digit tag (#1234567890)", () => {
    const { textNodes } = build("a #1234567890 b");
    expect(collectTagRanges(textNodes)).toHaveLength(0);
  });

  test("accepts mixed digit+letter tag (#1a, #a1)", () => {
    expect(collectTagRanges(build("x #1a y").textNodes)).toHaveLength(1);
    expect(collectTagRanges(build("x #a1 y").textNodes)).toHaveLength(1);
  });

  test("accepts digit-only body with hyphen (#1-2)", () => {
    // '-' counts as non-numerical, so this passes Obsidian's rule.
    const { textNodes } = build("x #1-2 y");
    expect(collectTagRanges(textNodes)).toHaveLength(1);
  });
});

describe("collectTagRanges - cross-text-node tags", () => {
  test("merges tag split by inline element (e.g., search highlight)", () => {
    // Simulates Obsidian's search highlight: <mark> in the middle of a tag.
    const { textNodes } = build("hello #foo<mark>bar</mark> baz");
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    // span across nodes: start in "hello #foo", end in "bar"
    expect(ranges[0].startNode.nodeValue).toContain("#foo");
    expect(ranges[0].endNode.nodeValue).toBe("bar");
    expect(rangeText(ranges[0])).toBe("#foobar");
  });

  test("does not extend into a node whose first char is a boundary", () => {
    const { textNodes } = build("hello #foo<mark> bar</mark>");
    // " bar" starts with space -> stop extending; tag is just "#foo".
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#foo");
  });

  test("respects boundary check across nodes when '#' is at end of one node", () => {
    // '#' at end of first text node, alnum starts in next node: accept and span.
    const { textNodes } = build("hello #<mark>foo</mark> bar");
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#foo");
  });

  test("merges tag body split around a slash", () => {
    const { textNodes } = build("hello #project<mark>/alpha</mark> done");
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#project/alpha");
  });

  test("merges tag body split around a hyphen", () => {
    const { textNodes } = build("hello #alpha<mark>-beta</mark> done");
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#alpha-beta");
  });

  test("merges tag body split around an underscore", () => {
    const { textNodes } = build("hello #alpha<mark>_beta</mark> done");
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#alpha_beta");
  });

  test("extends across an empty text node in the middle of a tag", () => {
    const root = document.createElement("div");
    const t1 = document.createTextNode("hello #foo");
    const mark = document.createElement("mark");
    const empty = document.createTextNode("");
    mark.appendChild(empty);
    const t2 = document.createTextNode("bar baz");
    root.append(t1, mark, t2);

    const ranges = collectTagRanges([t1, empty, t2]);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#foobar");

    wrapRanges(ranges, "search-tag");
    expect(root.querySelector(".stisr-tag").textContent).toBe("#foobar");
    expect(root.textContent).toBe("hello #foobar baz");
  });

  test("accepts a tag followed only by a trailing empty text node", () => {
    const root = document.createElement("div");
    const t1 = document.createTextNode("hello #foo");
    const empty = document.createTextNode("");
    root.append(t1, empty);

    const ranges = collectTagRanges([t1, empty]);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#foo");
  });
});

describe("collectTagRanges - skip already-wrapped", () => {
  test("ignores text inside a .stisr-tag span", () => {
    const { textNodes } = build('a <span class="stisr-tag search-tag">#foo</span> #bar');
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#bar");
  });

  test("ignores text inside a legacy .search-tag span", () => {
    const { textNodes } = build('a <span class="search-tag">#foo</span> #bar');
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#bar");
  });
});

describe("wrapRanges - DOM mutation", () => {
  test("wraps a single-node range with stisr-tag + user class", () => {
    const { root, textNodes } = build("hello #foo bar");
    const ranges = collectTagRanges(textNodes);
    wrapRanges(ranges, "search-tag");
    const wraps = root.querySelectorAll(".stisr-tag");
    expect(wraps).toHaveLength(1);
    expect(wraps[0].textContent).toBe("#foo");
    expect(wraps[0].className).toBe("stisr-tag search-tag");
  });

  test("wraps a cross-node range using extractContents fallback", () => {
    const { root, textNodes } = build("hello #foo<mark>bar</mark> baz");
    const ranges = collectTagRanges(textNodes);
    wrapRanges(ranges, "search-tag");
    const wraps = root.querySelectorAll(".stisr-tag");
    expect(wraps).toHaveLength(1);
    expect(wraps[0].textContent).toBe("#foobar");
  });

  test("falls back to DEFAULT_SETTINGS class when wrapperClass falsy", () => {
    const { root, textNodes } = build("a #foo b");
    wrapRanges(collectTagRanges(textNodes), "");
    expect(root.querySelector(".stisr-tag").className).toBe("stisr-tag search-tag");
  });

  test("wraps multiple tags while preserving surrounding text", () => {
    const { root, textNodes } = build("before #one middle #two after");
    wrapRanges(collectTagRanges(textNodes), "search-tag");
    const wraps = root.querySelectorAll(".stisr-tag");
    expect([...wraps].map((wrap) => wrap.textContent)).toEqual(["#one", "#two"]);
    expect(root.textContent).toBe("before #one middle #two after");
  });

  test("leaves rows without tags unchanged", () => {
    const { root, textNodes } = build("plain search result with no hashtags");
    wrapRanges(collectTagRanges(textNodes), "search-tag");
    expect(root.querySelector(".stisr-tag")).toBeNull();
    expect(root.textContent).toBe("plain search result with no hashtags");
  });
});

describe("plugin row processing", () => {
  function plugin() {
    return new StyleTagsInSearchResultsPlugin();
  }

  function row(text) {
    const el = document.createElement("div");
    el.className = "search-result-file-match";
    el.textContent = text;
    document.body.appendChild(el);
    return el;
  }

  test("processing the same row twice does not double-wrap tags", () => {
    const p = plugin();
    const el = row("hello #foo");

    p._processRow(el);
    p._processRow(el);

    const wraps = el.querySelectorAll(".stisr-tag");
    expect(wraps).toHaveLength(1);
    expect(wraps[0].textContent).toBe("#foo");
    expect(el.textContent).toBe("hello #foo");
  });

  test("force processing unwraps and rewraps without nesting", () => {
    const p = plugin();
    const el = row("hello #foo");

    p._processRow(el);
    p._processRow(el, true);

    const wraps = el.querySelectorAll(".stisr-tag");
    expect(wraps).toHaveLength(1);
    expect(wraps[0].querySelector(".stisr-tag")).toBeNull();
    expect(wraps[0].textContent).toBe("#foo");
  });

  test("notices when a row changes from tagged to untagged and back", () => {
    const p = plugin();
    const el = row("old #foo");

    p._processRow(el);
    expect(el.querySelector(".stisr-tag").textContent).toBe("#foo");

    el.textContent = "plain result";
    p._processRow(el);
    expect(el.querySelector(".stisr-tag")).toBeNull();
    expect(el.dataset.stisr).toBe("1");

    el.textContent = "new #longbar";
    p._processRow(el);
    expect(el.querySelector(".stisr-tag").textContent).toBe("#longbar");
  });

  test("force rescan re-wraps with the new wrapper class even when hide is off", () => {
    const p = plugin();
    p.settings.hideInSearch = false;
    const root = document.createElement("div");
    root.className = "search-results-children";
    const el = document.createElement("div");
    el.className = "search-result-file-match";
    el.textContent = "hello #foo";
    root.appendChild(el);
    document.body.appendChild(root);

    p._processRow(el);
    expect(el.querySelector(".stisr-tag").className).toBe("stisr-tag search-tag");

    p.settings.wrapperClass = "my-custom-class";
    p._scanRoot(root, true);

    const wraps = el.querySelectorAll(".stisr-tag");
    expect(wraps).toHaveLength(1);
    expect(wraps[0].className).toBe("stisr-tag my-custom-class");
    expect(el.textContent).toBe("hello #foo");
  });

  test("revert unwraps plugin and legacy spans in search leaves", () => {
    const p = plugin();
    const leafRoot = document.createElement("div");
    leafRoot.className = "workspace-leaf-content stisr-hide-tags";
    leafRoot.dataset.type = "search";
    leafRoot.innerHTML = `
      <div class="search-results-children">
        <div class="search-result-file-match">
          a <span class="stisr-tag search-tag">#foo</span>
          b <span class="search-tag">#bar</span>
          <span class="search-result-file-matched-text"></span>
        </div>
      </div>
    `;
    p.app = { workspace: { getLeavesOfType: () => [{ view: { containerEl: leafRoot } }] } };

    p._revertAllSearchLeaves();

    expect(leafRoot.querySelector(".stisr-tag")).toBeNull();
    expect(leafRoot.querySelector(".search-tag")).toBeNull();
    expect(leafRoot.querySelector(".search-result-file-matched-text")).toBeNull();
    expect(leafRoot.classList.contains("stisr-hide-tags")).toBe(false);
    expect(leafRoot.textContent).toContain("#foo");
    expect(leafRoot.textContent).toContain("#bar");
  });
});

describe("parseWrapAheadPx", () => {
  test("accepts zero (explicitly disabling pre-wrap margin)", () => {
    expect(parseWrapAheadPx("0")).toBe(0);
    expect(parseWrapAheadPx(0)).toBe(0);
  });

  test("accepts positive values", () => {
    expect(parseWrapAheadPx("256")).toBe(256);
    expect(parseWrapAheadPx(64)).toBe(64);
  });

  test("falls back to the default for empty, negative, or garbage input", () => {
    expect(parseWrapAheadPx("")).toBe(128);
    expect(parseWrapAheadPx("  ")).toBe(128);
    expect(parseWrapAheadPx("-5")).toBe(128);
    expect(parseWrapAheadPx("abc")).toBe(128);
    expect(parseWrapAheadPx(undefined)).toBe(128);
    expect(parseWrapAheadPx(NaN)).toBe(128);
  });
});
