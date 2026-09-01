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

**Three shops run on this machine, and the one the owner uses is not the one
whose name suggests it.** Get this wrong and you will spend an evening proving
that a perfectly healthy process is perfectly healthy. That is not hypothetical:
it is where this section came from.

| Address | nginx sends it to | Unit | What it is |
|---|---|---|---|
| **`xtechpos.com`**, `www.xtechpos.com` | `127.0.0.1:4000` | **`pos.service`** | **The shop the owner actually opens.** Their live data. |
| `protech.xtechpos.com` | `127.0.0.1:4100` | `pos-tenant@protech` | A tenant. Not what the owner browses. |
| `admin.xtechpos.com` | `127.0.0.1:4090` | `pos-console` | Vendor console |

Server is `159.203.185.221`, checkout at `/srv/pos`. A tenant keeps its database
at `/var/lib/pos/tenants/<slug>.sqlite` and its settings at
`/etc/pos/tenants/<slug>.env`; `pos.service` reads `/etc/pos/pos.env`.

### Never assume which shop is being talked about

When somebody says "the shop", "my shop", or reports a screen that will not
load, **find out which address they have in the browser before touching
anything**. The table above is a starting point, not an answer — nginx is what
decides, and it can be changed without anybody updating this file:

```bash
sudo nginx -T 2>/dev/null | grep -E "server_name|proxy_pass"
```

Read the `server_name` immediately above each `proxy_pass` — that pairing is the
truth. Then work on the port that pairing names, and no other.

### Which shop is serving a given page

`/api/health` reports the commit the process started with, so it identifies a
process rather than a directory. Ask the public address and the port you believe
is behind it, and compare:

```bash
curl -sk https://<the address they use>/api/health; echo
curl -s localhost:<the port you think it is>/api/health; echo
git -C /srv/pos rev-parse HEAD
```

- **Same `build`, matching `rev-parse`** — that is the right process and it is
  current.
- **Different `build` values** — they are two different processes. You are
  looking at the wrong one.
- **No `build` field at all** — that process predates the field, so it is
  running code older than the deploy that added it. It needs restarting
  whatever else is true.

### All three, every time

`pos.service` is easy to forget because the units with obvious names are the
tenants. It has been left behind by a deploy while the tenants restarted
correctly — same checkout, same commit on disk, a process from hours earlier
still serving it.

**The script's own version of that bug is fixed, and it is worth knowing what
it was**, because the shape recurs. It asked `systemctl list-unit-files | grep
-q "^pos.service"` under `set -o pipefail`: `grep -q` stops at the match and
exits, `systemctl` takes SIGPIPE on the rest of the units and dies 141, and
`pipefail` reports the pipeline as failed *although the match was found*. So the
deploy concluded the machine had no shop of its own — and a shop it does not
know about is one it never asks, so it does not appear in the final check at
all, and the run ends green. The console's detection was the same shape but
filtered by unit name, so its output was one line and no pipe ever broke; that
is why the console kept restarting while `pos.service` was skipped.

Detection is now `systemctl cat <unit>`, which uses no pipe. And the script
refuses outright if any installed `pos*.service` was never asked, so a wrong
answer to "does this unit exist" can no longer come out green. Held by
`server/test/deployScript.test.js`.

Check every unit, not the ones you expect:

```bash
systemctl list-units --all --type=service --no-pager | grep -i pos
sudo ss -ltnp | grep -E ':(4000|4090|4100)'
```

Compare the PIDs. Ones restarted together sit close in number; a much lower PID
is a process that did not come with the others.

Note that a node process shows up in `ss` as **`MainThread`**, not `node` —
`grep node` finds nothing and looks like an answer.

## Deploying

```bash
cd /srv/pos && ./deploy/deploy.sh
```

That backs up every database first, fast-forwards `main`, installs, builds the
client, restarts every running `pos-tenant@*` and the console, checks they came
back, and — last — **asks each one which commit it is actually serving**. It
refuses rather than half-finishing, and is safe to run twice.

Read what it prints. Three lines decide whether it worked:

- `Already up to date` near the top means the pull found nothing. Check you
  merged what you think you merged, and that the server is on `main`.
- `Checking what each shop is actually serving` lists every shop with the
  commit it answered. **Every one must say "up to date".**
- Green `==> Live at <sha>` at the bottom. It is only printed when the check
  above passed for every shop.

If a shop says **STILL ON OLD CODE**, the script exits 1 and names it. That is
the deploy telling you the files moved and the process did not — restart that
unit by name and run the deploy again.

If it says **Installed but not running, so left on the old code**, a shop is
down. It was not restarted because starting a shop somebody stopped is not a
deploy's decision, but it will serve the old build the moment it comes back.

## Then prove it

The script now does this itself, so this section is for checking by hand when
something looks wrong. `build` is what the *process* started with, so it is the
one figure that catches a restart that never happened:

**All three, including `pos.service`** — it is the one that gets forgotten,
and it is the one the owner is actually looking at:

```bash
systemctl is-active pos pos-tenant@protech pos-console
curl -fsS localhost:4000/api/health && echo   # pos.service — xtechpos.com
curl -fsS localhost:4100/api/health && echo   # the protech tenant
curl -fsS localhost:4090/api/health && echo   # the console
git -C /srv/pos rev-parse HEAD
```

The `build` in **every** reply must equal that `rev-parse`. Two failures to read
for:

- **`build` older than `rev-parse`** — that process did not restart. New screens,
  old routes: the client is static files read off disk, so it updates the moment
  the build finishes, while the routes stay in memory in a process from before.
  It shows up in the app as pages that will not load, and those pages now say so
  on screen rather than shimmering for ever.
- **No `build` field at all** — same thing, older still: that process predates
  the field itself.

Either way the cure is restarting that unit by name, then asking again.

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

**First, make sure you are looking at the right shop.** Far more often than a
stray process, the answer is that the port being examined is not the one serving
the person complaining — see "Never assume which shop is being talked about"
above. A process that is healthy on a port nobody is using looks exactly like a
mystery. Confirm the address → port pairing in nginx, then read on.

Everything below is written for one unit and one port. Substitute the pair you
confirmed — `pos.service` and `:4000`, `pos-tenant@<slug>` and its port, or
`pos-console` and `:4090` — and do not carry a port over from an earlier
example.

**Symptom:** `systemctl show <UNIT>` reports `MainPID=0` and
`ActiveEnterTimestamp` from days ago, the new code is definitely on disk
(`git log -1` in `/srv/pos` shows the merge), and the shop serves the old build
anyway.

**Cause:** a stray `node` process — left from an old run, started by hand, or
orphaned by a failed restart — is holding the port. The unit cannot bind, so
restarting it changes nothing, and systemd's status is about the unit rather
than about the port.

**Read the port before you touch it.** `fuser -k` on a healthy shop is a shop
you have just taken down — and once the deploy has restarted a shop, the process
holding its port is *supposed* to be there.

```bash
sudo ss -lptnp 'sport = :<PORT>'
systemctl is-active <UNIT>
```

Compare the PID `ss` reports against the unit's own `MainPID`. **The same number
means there is no stray** — the unit owns the port, and the problem is
elsewhere.

Three answers, and only one of them means kill something:

- **Nothing listening**, unit inactive → the unit failed to start. Not the
  stray-process case at all. Read `journalctl -u <UNIT> -n 50 --no-pager` and
  fix what it says.
- **Something listening**, unit `active`, **PID matches `MainPID`** → **that is
  the shop, working.** Stop here. If the app still misbehaves, it is the wrong
  port, the bundle, or the cache — go back to "Then prove it" and check `build`.
- **Something listening**, unit `inactive` or `failed`, or a PID that is *not*
  `MainPID` → *now* it is a stray, because the port is held by a process systemd
  does not own:

  ```bash
  sudo fuser -k <PORT>/tcp
  sudo systemctl start <UNIT>
  sleep 3                                  # node has to bind before it answers
  curl -fsS localhost:<PORT>/api/health && echo
  ```

The `sleep` is not decoration. `systemctl start` returns as soon as the unit is
*started*, which is before the process has opened its database and taken the
port; a `curl` on the next line fails against a shop that is coming up perfectly
well.

Ask the same three questions of every unit, not only the one you suspect.

**Never hand somebody the deploy block and this block as one thing to paste.**
Deploy first, read what it printed, and come here only if the checks actually
failed. Pasted together they kill the server the deploy has just brought up —
which has happened, on this shop.

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
sudo journalctl -u <UNIT> -n 50 --no-pager
```

A shop whose database it cannot write will restart five times in a minute and
then stay stopped, which is deliberate — it is visible in `status` instead of
looking busy.

**Node too old.** The server needs Node ≥ 24 for `node:sqlite`. `node --version`.

## What not to do

- **Never** `git checkout`, `reset --hard` or `stash` in `/srv/pos` without
  showing the user what would be lost first.
- **Never** delete or move a shop's env file — `/etc/pos/pos.env` for
  `pos.service`, `/etc/pos/tenants/<slug>.env` for a tenant. Each holds that
  shop's `ACCOUNT_SECRET`, and without that exact value every customer password
  and repair passcode in its database is permanently unreadable.
- **Never** restart during trading hours without asking. A restart drops whoever
  is mid-sale back to a loading screen; the person at the counter decides when
  that is acceptable.
- **Never** conclude a shop is fine from a port you did not confirm serves it.
  A healthy process on a port nobody is using proves nothing, and reads exactly
  like a mystery. Confirm address → port in nginx first, every time.
- Do not report a deploy as done on the strength of the script's exit code
  alone. Run the checks above and quote what they said.
- **Never** run `fuser -k` against a port whose unit is `active`. That is not a
  stray process, that is the shop.
