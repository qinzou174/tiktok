export function canonicalDouyinUrl(value) {
  const url = new URL(value);
  const match = url.pathname.match(/\/(?:share\/)?(video|note|slides)\/(\d+)/i);
  if (!match) return url.href;
  const type = match[1].toLowerCase() === "video" ? "video" : "note";
  return `https://www.douyin.com/${type}/${match[2]}`;
}
