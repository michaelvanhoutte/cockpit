# Home-screen widget

**A Panel's Items can sit on an Android home screen**, the way Google Calendar's widget shows the week at a glance. Android lets no installed web app put a widget on the home screen, so this is a small native app, *Cockpit widget*, whose only job is that widget. Cockpit itself stays the web app it is. It is installed from an APK attached to a GitHub Release (see "The Android widget" in `docs/deployment.md`), not from a store, and a person who installs the staging build has a second app beside it, each reading its own Cockpit.

**It signs in once, through Cockpit's own sign-in and consent**, as Claude's connection does, and every widget on the phone shares that sign-in. The consent page says the app will *read your Panels* and nothing else: it cannot change, finish or capture anything. It is listed in Settings under *Connected apps* as *Cockpit widget*, saying *Reads your Panels*, and **Disconnect** there signs every widget out (see Connected apps in `docs/product/accounts.md`). **Right after the first sign-in, one step explains that without it the list may be hours old** and opens Android's own dialog to let the app run in the background. It is asked once; declining leaves the widget working, refreshed when Android allows.

**Placing a widget opens a picker**: every Panel of items and every Filter panel, grouped by Workspace and then Dashboard in tab order. A Workspace or Dashboard with none is not listed, and a Panel of text never is. Several widgets can each show a different Panel, from any Workspace. Choosing one draws it at once.

**A widget is the Panel**, in the phone's light or dark theme:

- **Its heading** is the Workspace's colour dot, the Panel's name and its count, with *Updated 11:05* under them, then **↻** to refresh now and **+** to open Capture in the Panel's Workspace, with *File on* holding the Panel when it is a Panel of items, as the Panel's own **+** does. The count is the Items the Panel shows, an Item on two groups counted once.
- **Its rows** are every Item the Panel shows, in the Panel's own order and groups, one column, scrolling inside the widget. A Filter panel grouped by Dashboard or Panel has a heading for each group. A row is the **priority flag** (red High, amber Normal, grey Low, a faint one for none), the title, and under it the **due pill** and where else the Item is filed. The pill is *Overdue 2d* in red, *Due today* solid, *Due tomorrow* and *Due in 2d* soft, *Due in 3d* to *Due in 7d* outlined and, further off, a plain *Due 4 Nov*; no due date, no pill. The place line is *Dashboard ▸ Panel* for each other Panel the Item is filed on, or *Inbox* for an Item filed nowhere; an Item on this Panel alone has none. The Dashboard filter does not apply: a widget shows the whole Panel.
- **A Panel with nothing on it** shows its heading and the line Cockpit's own empty Panel says.
- **Tapping a row** opens that Item in the installed Cockpit, at the address **Copy link** gives, or in the browser without it.

**It stays fresh by itself**: Android's background scheduler reads about every 30 minutes, an alarm of the same period is the backstop when that is late, and **↻** reads now. *Updated* is how honest it is: **offline, or past a server error, the widget keeps the last list and says *offline* beside the time.**

**It says so in one line, and a tap does the useful thing, never an empty list:**

| The widget says | Because | A tap |
|---|---|---|
| *Signed out, tap to sign in* | Disconnect in Settings, or the person lost access. Every list kept on the phone is wiped with it | opens sign-in |
| *This panel was deleted, tap to pick another* | the Panel is gone | opens the picker for that widget |
| *Update Cockpit widget* | Cockpit retired the address this version reads | opens the release page |
