// Set the colour scheme before first paint so there is no flash: the stored choice, else the system.
// An external file, because the content security policy allows scripts from this origin only.
;(function () {
  // the embed view (/embed) takes the scheme of the page that frames it, by query, so it never flashes the other one
  var asked = new URLSearchParams(location.search).get('theme')
  if (location.pathname.indexOf('/embed') === 0 && (asked === 'dark' || asked === 'light')) {
    document.documentElement.setAttribute('data-scheme', asked)
    return
  }
  var s = localStorage.getItem('watch-scheme')
  var dark = s === 'dark' || ((s === null || s === 'auto') && !matchMedia('(prefers-color-scheme: light)').matches)
  document.documentElement.setAttribute('data-scheme', dark ? 'dark' : 'light')
})()
