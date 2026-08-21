---
name: deploy
description: Put the merged code live on the xtechpos.com server and prove it is actually serving it. Use when the user says deploy, push it live, put it on the server, update the droplet, or asks why a merged change is not showing up in the shop.
---

# Deploying this shop

The repo has a deploy script that does the work: `deploy/deploy.sh`. This skill
is about **driving it from the right place, and proving afterwards that the shop
is actually running the new code** — because the failure this installation keeps
hitting is a deploy that reports success while the shop serves the old build.

## First: where are you?

Everything below has to run **on the server**, not in the repo checkout you are
reading this from.

Check with `hostname` and `test -d /srv/pos`:

- **On the server** (`/srv/pos` exists) — run the commands yourself.
- **Anywhere else** — you cannot reach the droplet. Do not try to `ssh`; there is
  no key in a cloud session and port 22 is not open to it. Print the commands as
  one copy-paste block for the user to run, and say plainly that you cannot run
  them. Then **stop and wait for their output** rather than reporting a deploy
  you did not perform.

## The installation

| | |
|---|---|
| Server | `159.203.185.221`, checkout at `/srv/pos` |
| The shop | tenant slug **`protech`**, `pos-tenant@protech`, port **4100**, `protech.xtechpos.com` |
| Its database | `/var/lib/pos/tenants/protech.sqlite` |
| Its settings | `/etc/pos/tenants/protech.env` |
| Vendor console | `pos-console`, port **4090**, `admin.xtechpos.com` |

`protech` is a tenant like any other, not the machine's own shop. Whether this
machine also keeps one of its own — a `pos.service` on port 4000 — decides what
the script restarts, so check rather than assume:

```bash
systemctl list-unit-files | grep -E '^pos(\.|-tenant@|-console)'
```

If there is no `pos.service`, that is normal here: it is a landlord machine. An
older deploy script stopped at that point without restarting anything, so if you
see it say so and then finish quietly, nothing was restarted — check the units
by hand.

## Deploying

```bash
cd /srv/pos && ./deploy/deploy.sh
```

That backs up every database first, fast-forwards `main`, installs, builds the
client, restarts every running `pos-tenant@*` and the console, and checks they
came back. It refuses rather than half-finishing, and is safe to run twice.

Read what it prints. "Already up to date" means the pull found nothing — check
you merged what you think you merged.

## Then prove it

A deploy that finished is not a shop that is serving. Both of these have to pass:

```bash
systemctl is-active pos-tenant@protech pos-console
curl -fsS localhost:4100/api/health && echo
curl -fsS localhost:4090/api/health && echo
```

Then check the *browser* is getting the new build, which is a separate question
from whether the server restarted:

```bash
ls -l /srv/pos/client/dist/index.html      # should be minutes old, not weeks
grep -o 'index-[A-Za-z0-9]*\.js' /srv/pos/client/dist/index.html
```

If the shop still looks unchanged after that, it is the browser: hard-reload
(Ctrl+Shift+R), or check on a phone with no cache.

## When it says active but nothing works

This is the one that has cost this installation the most time, so check it
before anything else.

**Symptom:** `systemctl show pos-tenant@protech` reports `MainPID=0` and
`ActiveEnterTimestamp` from days ago, the new code is definitely on disk
(`git log -1` in `/srv/pos` shows the merge), and the shop serves the old build
anyway.

**Cause:** a stray `node` process — left from an old run, started by hand, or
orphaned by a failed restart — is holding port 4100. The unit cannot bind, so
restarting it changes nothing, and systemd's status is about the unit rather
than about the port.

**Find it, then take the port back:**

```bash
ss -lptnp 'sport = :4100'          # who actually holds it
sudo fuser -k 4100/tcp             # kill whatever that is
sudo systemctl start pos-tenant@protech
systemctl is-active pos-tenant@protech
curl -fsS localhost:4100/api/health && echo
```

Do the same with `:4090` for the console.

## Other failures, in the order they happen

**"There are uncommitted changes on the server."** Somebody edited a file
directly on the droplet. `git status --short` in `/srv/pos` says which. Never
discard it blind — show the user `git diff` and let them decide. (The script
already handles the one benign case, npm rewriting the lock files, on its own.)

**"Cannot fast-forward."** The server is on a diverged branch. `git -C /srv/pos
status` and `git -C /srv/pos log --oneline -3`, then decide with the user. Do
not force anything on a machine holding a live shop's books.

**A unit did not come back.** The script names it. Read its log:

```bash
sudo journalctl -u pos-tenant@protech -n 50 --no-pager
```

A shop whose database it cannot write will restart five times in a minute and
then stay stopped, which is deliberate — it is visible in `status` instead of
looking busy.

**Node too old.** The server needs Node ≥ 24 for `node:sqlite`. `node --version`.

## What not to do

- **Never** `git checkout`, `reset --hard` or `stash` in `/srv/pos` without
  showing the user what would be lost first.
- **Never** delete or move `/etc/pos/tenants/protech.env`. It holds
  `ACCOUNT_SECRET`, and without that exact value every customer password and
  repair passcode in the database is permanently unreadable.
- **Never** restart during trading hours without asking. A restart drops whoever
  is mid-sale back to a loading screen; the person at the counter decides when
  that is acceptable.
- Do not report a deploy as done on the strength of the script's exit code
  alone. Run the checks above and quote what they said.
