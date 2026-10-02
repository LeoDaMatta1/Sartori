// Markdown content negotiation (https://acceptmarkdown.com) and agent-friendly 404s.
//
// - GET/HEAD with `Accept: text/markdown` on an HTML page -> the pre-built Markdown twin from /md
//   (Content-Type: text/markdown, Vary: Accept). Browsers (text/html, */*) still get the HTML.
// - HTML responses also carry `Vary: Accept` so caches keep both representations apart.
// - Unknown paths keep their real HTTP 404; with `Accept: text/markdown` the 404 body is Markdown.

const MARKDOWN = 'text/markdown';
const HTML = 'text/html';

export function parseAccept(header) {
  return (header || '')
    .split(',')
    .map((part) => {
      const [range, ...params] = part.trim().split(';').map((s) => s.trim());
      const qParam = params.find((p) => /^q=/i.test(p));
      const q = qParam ? Number.parseFloat(qParam.slice(2)) : 1;
      return { range: range.toLowerCase(), q: Number.isNaN(q) ? 0 : q };
    })
    .filter((e) => e.range);
}

function qFor(entries, type) {
  const [major] = type.split('/');
  const exact = entries.find((e) => e.range === type);
  if (exact) return { q: exact.q, explicit: true };
  const partial = entries.find((e) => e.range === `${major}/*`);
  if (partial) return { q: partial.q, explicit: false };
  const any = entries.find((e) => e.range === '*/*');
  return { q: any ? any.q : 0, explicit: false };
}

// Markdown wins only when the client names text/markdown itself and ranks it at least as high as HTML.
export function prefersMarkdown(acceptHeader) {
  const entries = parseAccept(acceptHeader);
  const md = qFor(entries, MARKDOWN);
  if (!md.explicit || md.q <= 0) return false;
  return md.q >= qFor(entries, HTML).q;
}

// Maps a request pathname to its Markdown twin (or null when the path is not a page).
export function markdownPathFor(pathname) {
  let p = pathname;
  if (p.endsWith('/')) p += 'index';
  p = p.replace(/\.html$/, '');
  if (/\.[a-z0-9]+$/i.test(p)) return null; // asset or other file type
  if (p === '/blog') p += '/index';
  return `/md${p === '' ? '/index' : p}.md`;
}

// Static assets and the Markdown twins themselves never pass through this function.
export const config = {
  path: '/*',
  excludedPath: ['/md/*', '/assets/*', '/img/*', '/painting/img/*', '/painting/video/*', '/*.png', '/*.jpg', '/*.ico', '/*.svg', '/*.mp4', '/*.xml', '/*.txt'],
};

export function notFoundMarkdown(rawPathname, origin) {
  const pathname = rawPathname.replace(/\/index\.html?$/, '/') || '/';
  return [
    '# 404: Page not found',
    '',
    `The page \`${pathname}\` does not exist on Sartori Corporation's website. It may have moved or been removed.`,
    '',
    'Where to go next:',
    '',
    `- [llms.txt](${origin}/llms.txt): overview of the site, services and when to use it`,
    `- [Sitemap](${origin}/sitemap.xml): every public page`,
    `- [Home page](${origin}/): Cape Cod painting services, reviews and FAQ`,
    `- [Blog](${origin}/blog/index.html): painting guides for Cape Cod homeowners`,
    '',
    'Contact: (508) 246-3038 or estimate@sartoricorporationusa.com',
    '',
  ].join('\n');
}

function withVary(headers) {
  const out = new Headers(headers);
  const vary = (out.get('vary') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!vary.some((v) => v.toLowerCase() === 'accept' || v === '*')) vary.push('Accept');
  out.set('vary', vary.join(', '));
  return out;
}

export default async (request, context) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return context.next();

  const url = new URL(request.url);
  const wantsMarkdown = prefersMarkdown(request.headers.get('accept'));

  if (wantsMarkdown) {
    const mdPath = markdownPathFor(url.pathname);
    if (mdPath) {
      const md = await fetch(new URL(mdPath, url.origin), { headers: { accept: '*/*' } }).catch(() => null);
      if (md && md.status === 200) {
        const headers = withVary(md.headers);
        headers.set('content-type', `${MARKDOWN}; charset=utf-8`);
        headers.delete('content-length');
        headers.delete('content-encoding');
        return new Response(request.method === 'HEAD' ? null : await md.text(), { status: 200, headers });
      }
    }
  }

  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.includes(HTML) && !(wantsMarkdown && response.status === 404)) return response;

  if (wantsMarkdown && response.status === 404) {
    const headers = withVary(response.headers);
    headers.set('content-type', `${MARKDOWN}; charset=utf-8`);
    headers.delete('content-length');
    headers.delete('content-encoding');
    const body = notFoundMarkdown(url.pathname, url.origin);
    return new Response(request.method === 'HEAD' ? null : body, { status: 404, headers });
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: withVary(response.headers) });
};
