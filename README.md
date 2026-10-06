# Retail inMotion Shift & Assignment Manager

> **Retail inMotion edition.** Internal app for the Retail inMotion work site (`retailinmotion.atlassian.net`) and sandbox (`retailinmotion-sandbox1.atlassian.net`). It is a separate repository and Forge app from the Marketplace edition and is not published to the Atlassian Marketplace.
>
> Before the first deploy: run `forge register "Retail inMotion Shift Assignment Manager"`, put the printed id in `manifest.yml` (`app.id`), and add the `FORGE_EMAIL` / `FORGE_API_TOKEN` secrets. Merges deploy to the sandbox as before; the work site is deployed only by the manual **Deploy to Retail inMotion work site** workflow. The **Brand check** workflow fails if the Marketplace brand appears anywhere in the repository.

Forge app for shift-aware Jira Service Management assignment. Admins define shift groups and assignment rules; the app routes tickets to agents who are on shift.

## Modules

- **Admin page** (`src/frontend/admin.jsx`, resolver `src/index.js`): dashboard, roster, cover and absence entries, assignment rules, simulator and audit log. Every resolver checks Jira admin permission on the server.
- **Configure page** (`src/frontend/routingSettings.jsx`, resolver `src/routingSettings.js`): the routing mode.
- **Project page** (`src/frontend/schedule.jsx`, resolver `src/schedule.js`): a read-only Shift Schedule for all JSM users.
- **Background** (`src/background.js`): Jira issue events and a five-minute scheduled scan. Both check the routing mode first.

## Shift hours and rota import

Each shift group has its own working hours: the same every day, or different per day. Members can also have **personal hours**, which replace the group's hours for that person.

**Import Rota** (on the admin page) reads the monthly rota spreadsheet or pasted cells. The first column lists weekdays and the names are on the row above the first day. It takes each person's most recent week as their weekly pattern and can shift all times by a number of hours (Manila to Irish time is -7 in Irish summer time, -8 in winter). It matches each name to a Jira user and saves the results as personal hours in a Europe/Dublin shift group. Nothing is saved until you confirm the preview.

## Routing modes

| Mode | Behaviour |
| --- | --- |
| `off` (default) | Background events and scans do nothing. |
| `shadow` | Background routing runs against real tickets and logs each decision in the Audit Log, marked "Shadow". Jira is not changed. |
| `on` | Background routing changes Jira assignees. The admin must type ENABLE to switch to it. |

If the setting can't be read, routing is treated as `off`. Installs that were switched on before 0.9 stay `on`.

## Development

```bash
npm install
npm run check   # syntax check, bundle every Forge entry point, run tests
```

Pushing to `main` deploys to the Forge **development** environment and upgrades the Retail inMotion sandbox. The work site runs its own `work-site` environment and is updated only by the manual **Deploy to Retail inMotion work site** workflow. Pull requests only run the checks.
