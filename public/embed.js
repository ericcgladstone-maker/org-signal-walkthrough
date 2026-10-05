/* ?embed=1: the player inside a host page (no header, no full text, transparent). External, so the page runs under a strict script-src 'self' CSP. */
if (/[?&]embed=1(&|$)/.test(location.search)) document.documentElement.classList.add('embed');
