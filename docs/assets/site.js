// The landing page script. index.html loads defuss-shadcn (df$) from jsDelivr first; this module wires the page.
// The CRDT explorer is its own module (./explorer.js).
const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const peerFrames = () => document.querySelectorAll('#playground iframe');

// ---- theme: this page and the two demo frames follow one switch ------------------------------------------------------
// The frames are same-origin, so the page repaints their roots directly; the saved value lets a reloaded frame (and a
// demo opened in its own tab) start in the same theme. A postMessage protocol would also work across origins, which
// this site does not need. VERIFIED: e2e/browser/site.spec.mjs sees both frames follow the switch.
const themeToggle = $('theme-toggle');
const paint = (doc, dark) => {
  doc.documentElement.classList.toggle('dark', dark);
  doc.documentElement.style.colorScheme = dark ? 'dark' : 'light';
};
const frameDocument = (frame) => { try { return frame.contentDocument; } catch { return null; } };
function setTheme(dark) {
  paint(document, dark);
  for (const frame of peerFrames()) {
    const doc = frameDocument(frame);
    if (doc?.documentElement) paint(doc, dark);
  }
  themeToggle.checked = dark;
  try { localStorage.setItem('defuss-shadcn-theme', JSON.stringify(dark ? 'dark' : 'light')); } catch {}
}
themeToggle.checked = document.documentElement.classList.contains('dark');
themeToggle.addEventListener('change', () => setTheme(themeToggle.checked));

// ---- the two-peer demo -----------------------------------------------------------------------------------------------
// Nothing loads before the click: the start button swaps the template's two frames in. Both frames get one room name
// per page load, so Peer B finds Peer A's room without typing and two visitors on the hosted server do not meet.
// VERIFIED: e2e/browser/site.spec.mjs finds no frame before the click, then both peers in the page's room.
const playground = $('playground');
const peersTemplate = playground.querySelector('template');
const room = `demo-${Math.random().toString(36).slice(2, 8)}`;
for (const frame of peersTemplate.content.querySelectorAll('iframe')) {
  frame.setAttribute('src', `${frame.getAttribute('src')}&room=${room}`);
}
function startPeers() {
  playground.replaceChildren(peersTemplate.content.cloneNode(true));
  playground.dataset.played = '';
  peerFrames()[0]?.focus();
}
$('playground-start').addEventListener('click', startPeers);
$('playground-restart').addEventListener('click', () => {
  if (!('played' in playground.dataset)) {
    startPeers();
    return;
  }
  // replace(): restarting the demo must not add entries to the tab's session history
  for (const frame of peerFrames()) frame.contentWindow?.location.replace(frame.src);
});

// ---- in-page links scroll without adding history entries -------------------------------------------------------------
// Layout offsets ignore transforms, so a section still in its scroll-driven reveal lands at its scroll margin
// (defuss-dom-router measured scrollIntoView() 62 px off for such a section).
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target.closest('a[href^="#"]');
  let id = '';
  try { id = anchor ? decodeURIComponent(anchor.hash.slice(1)) : ''; } catch { return; }
  const target = id && document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  let top = 0;
  for (let node = target; node; node = node.offsetParent) top += node.offsetTop;
  scrollTo({ top: top - parseFloat(getComputedStyle(target).scrollMarginTop || '0'), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  history.replaceState(history.state, '', anchor.hash);
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
});

// ---- copy buttons ----------------------------------------------------------------------------------------------------
async function copyText(text, status, label) {
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = 'Copied';
  } catch {
    status.textContent = 'Copy failed';
  }
  if (!label) return;
  label.textContent = status.textContent;
  setTimeout(() => { label.textContent = 'Copy prompt'; }, 2000);
}
// Each block copies its visible lines (the checked tab's, when it has tabs).
for (const button of document.querySelectorAll('.mk-code-block-copy')) {
  button.addEventListener('click', () => {
    const block = button.closest('.mk-code-block');
    const tab = block.querySelector('.mk-code-block-tabs input:checked')?.value;
    const pre = tab ? block.querySelector(`pre[data-tab="${tab}"]`) : block.querySelector('pre');
    const lines = [...pre.querySelectorAll('code > span')].map((line) => line.textContent);
    void copyText(lines.join('\n'), block.querySelector('.mk-code-block-status'));
  });
}
$('copy-prompt').addEventListener('click', () => void copyText(
  [...document.querySelectorAll('#agent-prompt pre:not([data-tone]) code')].map((code) => code.textContent).join('\n'),
  $('copy-prompt-status'), $('copy-prompt').querySelector('span')));
