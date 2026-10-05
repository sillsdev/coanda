import { expect, test } from "vite-plus/test";
import { findQuote, quoteAt } from "./textQuote.ts";

test("a quote is found again after text is added before it", () => {
  const before = "Make a book. Choose a template. Then make a book from it.";
  const quote = quoteAt(before, 37, 48); // the second "make a book"
  expect(quote.exact).toBe("make a book");
  const after = "Welcome! " + before;
  expect(findQuote(after, quote)).toEqual({ start: 46, end: 57 });
});

test("a repeated passage is told apart by its surroundings", () => {
  const text = "Click Save. Type a title. Click Save.";
  const second = quoteAt(text, 26, 36);
  expect(findQuote(text, second)).toEqual({ start: 26, end: 36 });
  const first = quoteAt(text, 0, 10);
  expect(findQuote(text, first)).toEqual({ start: 0, end: 10 });
});

test("a quote whose words are gone is not found", () => {
  const quote = quoteAt("The flower is a placeholder.", 4, 10);
  expect(findQuote("The image is a placeholder.", quote)).toBeNull();
});
