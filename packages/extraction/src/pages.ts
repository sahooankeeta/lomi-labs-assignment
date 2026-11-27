/** Pages are joined with a blank line, so a page start is also a paragraph boundary. */
export const PAGE_SEPARATOR = '\n\n';

/** `pageOffsets[i]` is the offset in `text` where page `i + 1` starts. */
export function joinPages(pages: string[]): { text: string; pageOffsets: number[] } {
  const pageOffsets: number[] = [];
  let text = '';
  pages.forEach((page, i) => {
    if (i > 0) text += PAGE_SEPARATOR;
    pageOffsets.push(text.length);
    text += page;
  });
  return { text, pageOffsets };
}

/** 1-based page of `offset`: the last page whose start is `<= offset` (empty pages never win). */
export function pageOf(offset: number, pageOffsets: number[]): number {
  let lo = 0;
  let hi = pageOffsets.length - 1;
  let page = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pageOffsets[mid]! <= offset) {
      page = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return page + 1;
}
