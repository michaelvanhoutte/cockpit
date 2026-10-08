/*
 * Whether the app is dark, decided before anything else runs. vite.config.ts
 * writes this file into the document's head as an inline script, so the first
 * frame is already the right one: applying it from the app's own script would
 * paint light on every dark cold open, and cost entry bundle to do it.
 *
 * The stored choice (`cockpit.appearance`: `light` or `dark`, absent for Match
 * device, anything else treated as absent) wins over the device's colour scheme.
 * The same script follows both while the page is open: the device switching, and
 * another tab storing a different choice, or this tab announcing its own. It is
 * plain ES5 and takes the window as its argument so a test can hand it a fake one (tests/unit/appearanceBoot.test.ts).
 */
(function (win) {
  var KEY = 'cockpit.appearance';
  var FLAG = 'data-app-dark';
  var device;
  try {
    device = win.matchMedia('(prefers-color-scheme: dark)');
  } catch (e) {
    device = null;
  }
  var chosen;
  function dark() {
    var stored = null;
    if (chosen !== undefined) stored = chosen;
    else {
      try {
        stored = win.localStorage.getItem(KEY);
      } catch (e) {
        stored = null;
      }
    }
    return stored === 'dark' || (stored !== 'light' && !!device && device.matches);
  }
  function flag() {
    var root = win.document.documentElement;
    if (dark()) root.setAttribute(FLAG, '');
    else root.removeAttribute(FLAG);
  }
  flag();
  if (device) device.addEventListener('change', flag);
  win.addEventListener('storage', function (event) {
    if (event.key === KEY || event.key === null) {
      chosen = undefined;
      flag();
    }
  });
  // This tab's own choice (Settings, Appearance): a `storage` event does not
  // fire in the tab that wrote, and storage may refuse the write, so the choice
  // arrives here as well. `detail` is `light`, `dark`, or null for Match device.
  win.addEventListener('cockpit:appearance', function (event) {
    chosen = event.detail;
    flag();
  });
})(window);
