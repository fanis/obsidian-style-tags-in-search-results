import { describe, test, expect } from "vitest";
import { collectTagRanges, wrapRanges } from "../main.js";

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

  test("wraps a nested tag", () => {
    const { textNodes } = build("see #project/alpha now");
    const ranges = collectTagRanges(textNodes);
    expect(ranges).toHaveLength(1);
    expect(rangeText(ranges[0])).toBe("#project/alpha");
  });

  test("wraps tag with internal hyphens", () => {
    const { textNodes } = build("here #a-b-c done");
    const ranges = collectTagRanges(textNodes);
    expect(rangeText(ranges[0])).toBe("#a-b-c");
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
});
