import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

/**
 * The address-confirmation bridge.
 *
 * Supabase is told to send confirmation links here rather than straight at the
 * app's `budj://` scheme, for two reasons that only show up in the wild:
 * confirmation links are opened from mail clients, a great many of which open
 * links in an embedded browser that will not follow a redirect into a custom
 * scheme; and some pre-fetch links to scan them, which against a scheme
 * redirect burns the single-use token before anybody taps it. An ordinary
 * `https://` link is the only thing every mail client agrees how to open.
 *
 * **This is a page and not a 302, and that part is not a style choice.**
 * Supabase's implicit flow returns the session in the URL *fragment*, and a
 * fragment is never sent to the server — a redirect handler cannot read
 * `#access_token=…` because it was never given it. Only the browser has it, so
 * only the browser can hand it over.
 *
 * Specified as D17 in the `add-ios-onboarding` change.
 */

/** Where the app is registered to receive it. Must match `CFBundleURLSchemes`. */
const APP_LINK = 'budj://auth/confirm';

const STYLE = `
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #14110d; color: #f5f1ea;
  }
  main { max-width: 30rem; padding: 2rem 1.5rem; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  p { margin: 0 0 1.5rem; color: #b9b1a4; }
  a {
    display: inline-block; padding: 0.9rem 2rem; border-radius: 999px;
    background: #f0b323; color: #14110d; font-weight: 600; text-decoration: none;
  }
  a[hidden] { display: none; }
`;

const SCRIPT = `
(function () {
  var carried = window.location.search + window.location.hash;
  var explain = document.getElementById('explain');
  var open = document.getElementById('open');

  // Nothing to hand over: somebody has found this page on its own.
  if (carried.length < 2) {
    document.getElementById('title').textContent = 'Nothing to confirm here';
    explain.textContent = 'Open the link from your email to confirm your address.';
    return;
  }

  var target = ${JSON.stringify(APP_LINK)} + carried;
  open.setAttribute('href', target);
  open.hidden = false;

  // Take the session out of the address bar and out of the history entry before
  // handing it over. It has already been read into 'target'.
  try { window.history.replaceState(null, '', window.location.pathname); } catch (e) {}

  // Deferred a beat so the button has painted. Where the automatic hop is
  // blocked — which is the embedded browser this page exists for — what is left
  // on screen is the same hand-off behind a tap the person made.
  window.setTimeout(function () { window.location.href = target; }, 50);
})();
`;

function sha256(source: string): string {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Confirming your email address</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1 id="title">Your email address is confirmed</h1>
  <p id="explain">Opening Budj to finish signing you in.</p>
  <a id="open" href="${APP_LINK}" hidden>Open Budj</a>
  <noscript><p>Open Budj on this device to finish signing in.</p></noscript>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;

/**
 * Set per-route rather than relying on the global helmet configuration, which
 * is disabled outside production — without this the page would work in
 * development and be blocked by `script-src 'self'` in production, which is the
 * worst of both. Hashes rather than a nonce because the page is static: they
 * are computed from the very strings embedded above, so editing the script
 * cannot leave a stale hash behind.
 */
const helmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'none'"],
      'script-src': [sha256(SCRIPT)],
      'style-src': [sha256(STYLE)],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': ["'none'"],
    },
  },
};

const confirmRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/confirm',
    {
      helmet: helmetOptions,
      // Not part of the client contract: no app calls this, a browser does.
      schema: { hide: true },
    },
    async (_request, reply) =>
      reply
        .type('text/html; charset=utf-8')
        // The page is static, but what arrives with it is a single-use session.
        // Nothing about this exchange belongs in a cache or a referrer.
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .send(PAGE),
  );
};

export default confirmRoutes;
