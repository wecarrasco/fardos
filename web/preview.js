import { cardImageUrl, scryfallPageUrl, otherDecksWithCard, totalsForName } from './cards.js';

/**
 * Floating card preview.
 *
 * Shows the printing's picture plus the facts the picture cannot carry: how
 * many copies the seller has, and which other decks stock the same card.
 *
 * Opens on hover with a short delay, so running the cursor down a list of
 * twenty results does not fire twenty image requests. Touch devices have no
 * hover, so there the card name is a button that toggles the panel instead.
 */

const OPEN_DELAY_MS = 220;
const GAP = 14;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Images already fetched, so reopening a card is instant. */
const imageCache = new Map();

function preloadImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
  imageCache.set(url, p);
  return p;
}

export function createPreview(getIndex) {
  const el = document.createElement('div');
  el.className = 'cardpreview';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Card preview');
  document.body.appendChild(el);

  let openTimer = null;
  let current = null;      // the anchor element the panel belongs to
  let pinned = false;      // opened by tap/click rather than hover

  const isTouch = window.matchMedia('(hover: none)').matches;

  function render(card, deckId) {
    const index = getIndex();
    const img = cardImageUrl(card, 'normal');
    const page = scryfallPageUrl(card);
    const others = otherDecksWithCard(index, card, deckId);
    const totals = totalsForName(index, card.name);

    const elsewhere = others.length
      ? `<div class="cp-also">
           <div class="cp-also-head">Also in ${others.length} other ${others.length === 1 ? 'deck' : 'decks'}</div>
           <ul>${others.slice(0, 6).map((o) =>
             `<li><span class="cp-q">${o.quantity}&times;</span>
                  <a href="${esc(o.deckUrl)}" target="_blank" rel="noopener noreferrer">${esc(o.deckName)}</a></li>`).join('')}
           ${others.length > 6 ? `<li class="cp-more">+${others.length - 6} more</li>` : ''}</ul>
         </div>`
      : '<div class="cp-also cp-only">Only in this deck.</div>';

    // Distinct printings matter: the same card may also be here in another set
    // or as a foil, which the "also in" list deliberately does not count.
    const nameTotal = totals.printings > 1
      ? `<div class="cp-total">${totals.copies} total across ${totals.printings} printings in ${totals.decks} ${totals.decks === 1 ? 'deck' : 'decks'}</div>`
      : '';

    el.innerHTML = `
      <div class="cp-img">${
        img ? `<img alt="${esc(card.name)}" src="${esc(img)}" loading="lazy">`
            : '<div class="cp-noimg">No picture for this printing</div>'
      }</div>
      <div class="cp-body">
        <div class="cp-name">${esc(card.name)}${card.foil ? ' <span class="foil">FOIL</span>' : ''}</div>
        <div class="cp-meta">
          ${esc(card.setName ?? 'Unknown set')}${card.setId ? ` (${esc(card.setId.toUpperCase())})` : ''}
          ${card.collectorNumber ? ` #${esc(card.collectorNumber)}` : ''}
        </div>
        <div class="cp-meta">
          ${card.rarity ? esc(card.rarity) : ''}${card.rarity && card.typeName ? ' &middot; ' : ''}${esc(card.typeName ?? '')}
        </div>
        <div class="cp-here"><b>${card.quantity}</b> in this deck</div>
        ${nameTotal}
        ${elsewhere}
        ${page ? `<a class="cp-link" href="${esc(page)}" target="_blank" rel="noopener noreferrer">View on Scryfall &rarr;</a>` : ''}
      </div>`;

    if (img) void preloadImage(img);
  }

  /** Keep the panel on screen: prefer the right of the anchor, flip or clamp. */
  function position(anchor) {
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    let left = a.right + GAP;
    if (left + w > vw - 8) left = a.left - w - GAP;   // flip to the left
    if (left < 8) left = Math.max(8, (vw - w) / 2);   // no room either side

    let top = a.top + a.height / 2 - h / 2;           // vertically centred
    top = Math.min(Math.max(8, top), vh - h - 8);

    el.style.left = `${Math.round(left + window.scrollX)}px`;
    el.style.top = `${Math.round(top + window.scrollY)}px`;
  }

  function open(anchor, card, deckId, { pin = false } = {}) {
    current = anchor;
    pinned = pin;
    render(card, deckId);
    el.hidden = false;
    el.classList.toggle('is-pinned', pin);
    position(anchor);
    anchor.setAttribute('aria-expanded', 'true');

    // CSS reserves the card's aspect ratio so the height is right immediately,
    // but a picture that fails to load collapses the box. Re-check once it
    // settles rather than leaving the panel misplaced.
    const img = el.querySelector('img');
    if (img && !img.complete) {
      const settle = () => { if (current === anchor) position(anchor); };
      img.addEventListener('load', settle, { once: true });
      img.addEventListener('error', settle, { once: true });
    }
  }

  function close() {
    clearTimeout(openTimer);
    openTimer = null;
    if (current) current.setAttribute('aria-expanded', 'false');
    current = null;
    pinned = false;
    el.hidden = true;
  }

  /**
   * Wire a results container. Cards are looked up through `resolve`, which the
   * caller uses to map an element back to the card it was rendered from.
   *
   * @param {HTMLElement} root
   * @param {(anchor: HTMLElement) => {card: object, deckId: string}|null} resolve
   */
  function attach(root, resolve) {
    const anchorOf = (target) => target?.closest?.('[data-card]') ?? null;

    if (!isTouch) {
      root.addEventListener('mouseover', (ev) => {
        const anchor = anchorOf(ev.target);
        if (!anchor || anchor === current || pinned) return;
        clearTimeout(openTimer);
        openTimer = setTimeout(() => {
          const hit = resolve(anchor);
          if (hit) open(anchor, hit.card, hit.deckId);
        }, OPEN_DELAY_MS);
      });

      root.addEventListener('mouseout', (ev) => {
        const anchor = anchorOf(ev.target);
        if (!anchor || pinned) return;
        // Ignore moves within the same anchor.
        if (anchor.contains(ev.relatedTarget)) return;
        clearTimeout(openTimer);
        if (anchor === current) close();
      });
    }

    // Click works on every device: taps on touch, and a way to pin the panel
    // open with the mouse so its links can be reached.
    root.addEventListener('click', (ev) => {
      const anchor = anchorOf(ev.target);
      if (!anchor) return;
      ev.preventDefault();
      if (current === anchor && pinned) return close();
      const hit = resolve(anchor);
      if (hit) open(anchor, hit.card, hit.deckId, { pin: true });
    });

    // Keyboard: the anchors are buttons, so focus opens and blur closes.
    root.addEventListener('focusin', (ev) => {
      const anchor = anchorOf(ev.target);
      if (!anchor) return;
      const hit = resolve(anchor);
      if (hit) open(anchor, hit.card, hit.deckId);
    });
    root.addEventListener('focusout', (ev) => {
      if (!pinned && anchorOf(ev.target) === current) close();
    });
  }

  // Anything that moves the page invalidates the position, so dismiss.
  window.addEventListener('scroll', () => { if (!pinned) close(); }, { passive: true });
  window.addEventListener('resize', close);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
  document.addEventListener('click', (ev) => {
    if (pinned && !el.contains(ev.target) && !ev.target.closest?.('[data-card]')) close();
  });

  return { attach, close };
}
