# Clock

A static website that shows a clock whose time and speed are controlled by an
admin. Plain HTML, CSS and vanilla JavaScript (ES modules), with no framework and
no build step. It is hosted on GitHub Pages and uses Supabase to store and sync
the clock state.

**Live:** [amahul.github.io/clock](https://amahul.github.io/clock/). The admin
page is at [amahul.github.io/clock/admin.html](https://amahul.github.io/clock/admin.html).

## The model

The whole clock is described by one small state object:

| Field               | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `anchor_real_time`  | Server time when the admin last changed the settings             |
| `anchor_clock_time` | The time the clock showed at that moment                         |
| `speed`             | `1` normal, `2` double, `0.5` half, `0` paused, negative = backwards |
| `timezone`          | IANA zone used for display, e.g. `Europe/Stockholm`              |

Every visitor computes the displayed time themselves:

```
displayed = anchor_clock_time + (serverNow - anchor_real_time) * speed
```

The state only changes when the admin does something, so the clock keeps
running smoothly without any network traffic in between.

### Admin actions

- **Set time**: the anchor moves to now and `anchor_clock_time` becomes the
  chosen time. Speed is kept.
- **Change speed**: the clock is re-anchored at the time it currently shows,
  then the new speed applies from there. This way the clock doesn't jump when the
  speed changes.
- **Reset to real time**: `anchor_clock_time = anchor_real_time = now` and
  `speed = 1`. The timezone is kept.

### Why `serverNow` and not the device clock

Visitors' device clocks can be off by seconds or minutes. If each visitor used
their own `Date.now()`, visitors would see different times. Instead, each client
estimates

```
serverNow = Date.now() + offset
```

where `offset` is measured against the Supabase server. The admin page uses the
same estimate when it writes a new state, so all anchors are in server time.

The timezone only affects formatting. It never changes which instant is shown.

`clock-core.js` never reads the clock itself. Every function takes `serverNow`
as an argument, so the tests are deterministic. Timestamps can be epoch
milliseconds, `Date` objects or ISO strings (the format Supabase returns for
`timestamptz`). Functions return new state objects with epoch milliseconds and
never change their input.

## Project layout

```
index.html            visitor page
admin.html            admin page (not linked from anywhere, noindex)
css/style.css         shared styles; css/admin.css adds the admin forms
js/admin.js           admin page: login, controls, calls to the admin functions
js/clock-core.js      pure clock model (no DOM, no network, no Date.now())
js/config.js          Supabase project URL + public anon key
js/app.js             visitor page: Supabase sync, server offset, rendering
supabase/setup.sql    database setup: table, RLS, functions, Realtime
tests/                node tests
```

## Supabase backend

`supabase/setup.sql` creates everything. It can be run again safely.

| Object                       | Who can use it     | What it does                                               |
| ---------------------------- | ------------------ | ---------------------------------------------------------- |
| `clock_state` (one row, id 1) | anyone: read only | The clock state; direct writes are refused                 |
| `admins`                     | nobody via the API | Emails allowed to change the clock                         |
| `get_server_time()`          | anyone             | Returns the server's `now()` for offset measurement        |
| `set_clock(time, speed, tz)` | admins             | Anchors at the server's `now()`; `null` args keep current  |
| `set_clock_speed(speed)`     | admins             | Changes speed, re-anchored on the server (no jump)         |
| `reset_clock()`              | admins             | Real time, speed 1, timezone kept                          |
| Realtime on `clock_state`    | anyone             | Pushes changes to open browsers                            |

The admin functions are `SECURITY DEFINER`: they run with the table owner's
rights, but first check that the signed-in user's email is in `admins`.

### Setup steps

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. **SQL Editor → New query**: paste `supabase/setup.sql` and run it.
3. **Authentication → Users → Add user → Create new user**: enter the admin's
   email and a strong password, and tick *Auto Confirm User*.
4. In the SQL editor, add that email (lowercase) to the admins table:
   ```sql
   insert into public.admins (email) values ('you@example.com') on conflict do nothing;
   ```
5. **Authentication → Sign In / Providers**: turn off *Allow new users to sign up*.
6. **Project Settings → API Keys**: copy the project URL and the `anon` public
   key (or the newer *publishable* key) into `js/config.js`.
7. **Authentication → URL Configuration**: set *Site URL* to
   `https://amahul.github.io/clock/` and add `https://amahul.github.io/clock/**`
   under *Redirect URLs*.

### Admin page

Open [admin.html](https://amahul.github.io/clock/admin.html) and log in with
the admin account. Nothing links to it, and it asks search engines not to index
it. That only keeps it out of sight: the security comes from the database,
which refuses changes from anyone not in `admins`.

Supabase Auth only supports emails, so a plain username like `anna` logs in as
`anna@clock.local`. Create such a user in the dashboard with *Auto Confirm
User* ticked, and add the full `anna@clock.local` to `admins`. Password reset
emails can't reach these addresses; set new passwords in the dashboard.

- Speed presets, the slider and the custom speed apply immediately through
  `set_clock_speed`, so the clock never jumps.
- The date/time field follows the clock live until you edit it. It is read
  in the selected timezone. **Save** calls `set_clock`. If only the timezone
  changed, the time is left to the server, so the clock keeps its current time.

### Keys

- The **anon / publishable key** is safe to publish. It is in every visitor's
  browser anyway. It only lets them do what RLS and the function grants allow:
  read the clock and call `get_server_time()`.
- The **service_role / secret key** bypasses RLS completely. It must never
  appear anywhere in this project: not in `config.js`, not in a commit, not
  in an ignored local file. This site is published as-is. `tests/config.test.js`
  fails if such a key shows up in any project file.

## Development

Serve the folder with any static server, for example:

```
npx serve .
# or
python -m http.server 8000
```

ES modules don't load from `file://`, so opening `index.html` directly
won't work.

Run the tests (Node 22 or newer):

```
npm test
```

## Deployment

Every push to `main` runs `.github/workflows/pages.yml`. It runs the tests,
copies the site files (`index.html`, `admin.html`, `css/`, `js/`) into a folder
and publishes that folder to GitHub Pages. Tests, SQL and docs aren't
published. If the tests fail, nothing is deployed.

One-time setup: **Settings → Pages → Source: GitHub Actions** in the repository.
Follow deployments on the **Actions** tab.

All paths in the site are relative, so it works from the `/clock/` subpath.
