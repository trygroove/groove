# The alpha allowlist

During the alpha only invited Google addresses can sign in (#854). This is how
the list is run.

## How it works

- The list is the Firestore collection `allowlist/{normalisedEmail}`: one
  document per address, trimmed and lower-cased. Clients cannot read or write
  it; only an account with the `admin: true` custom claim, or the admin
  credential, can (`firestore.rules`).
- A blocking `beforeSignIn` Auth function (`alphaAllowlistGate` in
  `functions/src/index.ts`, deciding through `src/access/signInGate.ts`)
  refuses every sign-in whose address is not on the list or not verified, a
  guest linking Google included. That is the enforcement; what the browser
  shows is only UI. It deploys with the other functions (`bun run deploy`),
  and it shipped in the same change that retired guest start, so it never went
  live ahead of the pages it sends people to.
- Firebase never runs a blocking function for an **anonymous** sign-in, so the
  function cannot stop a new guest session. Disabling the Anonymous provider
  (step 4 below) is the control for that, not the function.
- A refused sign-in is recorded in `signInAttempts/{normalisedEmail}` (address,
  first and last time, count). Approving an address removes its attempt.
- Guest start is retired. Existing guest sessions keep working on their
  projects; no new ones are created.

## Before the first deploy with enforcement

1. **Upgrade the Firebase project to Identity Platform** (Firebase console,
   Authentication, Settings). Blocking functions need it. This is a manual,
   owner-only step.
2. **Grandfather everyone who already signs in:**
   ```sh
   FIREBASE_PROJECT_ID=<project> bun run allowlist:seed
   ```
   It adds the address of every account that has a sign-in provider, and
   leaves guests alone. Run it **before** the gate deploys; until then,
   running it twice is harmless.

   Once the gate is live it is not: a refused sign-in still creates its
   Firebase Auth account, so "every account" then includes everyone the gate
   turned away. The script never seeds an address with a refused sign-in on
   record, and once `signInAttempts` holds anything it stops unless you pass
   the time the gate deployed, after which only older accounts are added:
   ```sh
   FIREBASE_PROJECT_ID=<project> bun run allowlist:seed -- --before 2026-10-01T12:00:00Z
   ```
   Even then it re-adds anyone created before the cutoff whom you have since
   removed, so after enforcement prefer approving people by name.
3. **Grant the first admin** (the account must have signed in once; the
   command allowlists the address either way):
   ```sh
   FIREBASE_PROJECT_ID=<project> bun run admin:grant -- you@example.com
   ```
   The claim reaches the browser with the next ID token: sign out and in again.
4. **Disable the Anonymous provider** in Authentication, Sign-in method. This
   is what stops new guest sessions: the blocking function never sees an
   anonymous sign-in, so leaving the provider on leaves guest start open to
   anyone who calls the SDK directly.
5. Deploy (`bun run deploy` includes `functions`).

The scripts use application default credentials
(`gcloud auth application-default login`, or `GOOGLE_APPLICATION_CREDENTIALS`).

## Internal accounts

An account with the `internal: true` custom claim (GRV-113,
`src/access/claims.ts`) is a team or test account: the browsers it signs into
are marked internal traffic, and its kept assistant turns are marked
`internal`, so the team's own use stays out of the product's measures. Which
accounts are internal is never written into the code. Flag one (it must have
signed in once) or stop flagging it:

```sh
FIREBASE_PROJECT_ID=<project> bun run internal:grant -- you@example.com
FIREBASE_PROJECT_ID=<project> bun run internal:revoke -- you@example.com
```

Both keep every other claim (`admin` included), and neither changes access:
the address still needs to be on the allowlist. The claim reaches the browser
with the next ID token, so sign out and in again. Revoking does not unmark a
browser the account already marked; `?internal=0` does. The QA pool is flagged
by `bun run qa:accounts`. When this replaced the address list, the team's own
accounts and the hands-on test accounts were flagged once with
`internal:grant`; a new team or test account needs the same.

## Approving people

- **Admin page:** `/admin`, visible only to admins (anyone else gets the 404
  page). Paste any number of addresses (one per line, separated by commas, or a
  column from the Tally export) and press Approve. It reports added, already
  listed and invalid. Below it are blocked sign-in attempts, each with one-click
  Approve, and the current list, each with Remove and Revoke.
- **Remove does not sign anyone out.** It stops the address's next sign-in,
  but `beforeSignIn` does not run when a session refreshes its ID token, so a
  person who is signed in stays signed in.
- **Revoke does** (#1147). After a confirmation it takes the address off the
  list and revokes the account's refresh tokens through the `revokeAccess`
  callable (`functions/src/index.ts`, deciding through
  `src/access/revokeAccess.ts`), so every session of theirs ends when its ID
  token next expires, within the hour. Their next sign-in is refused by the
  gate and lands in Blocked sign-ins, from where one click approves them
  again. The account is neither disabled nor deleted. An admin cannot revoke
  their own address, and an address that never signed in is simply taken off
  the list. The function refuses anyone without the `admin` claim.
- **Terminal:**
  ```sh
  FIREBASE_PROJECT_ID=<project> bun run allowlist:add -- export.csv more@example.com
  ```
  Arguments are files or addresses, read by the same parser as the page.

People who are refused see a page saying they are not on the alpha list yet,
with a Request access button to the form (`requestAccessUrl` in
`site.config.mjs`).

## Email alerts for blocked sign-ins

A Firestore trigger (`allowlistBlockedSignInAlert` in `functions/src/index.ts`,
deciding through `src/access/blockedSignInAlert.ts`) emails the admin when an
address is refused: on its first refusal, and again when it comes back 24
hours or more after its last attempt. Retries in between send nothing. The
email names the address, the attempt count, the first and last attempt times
(UTC) and links to `/admin`. It is separate from the gate, so a broken mail
server never slows or fails a sign-in; a failed send is logged as a warning and
dropped (the attempt is still listed in `/admin`). The logs never name the
address.

1. **Store the SMTP URL as a secret.** For Gmail, create an app password and
   use `smtps://you%40gmail.com:<app-password>@smtp.gmail.com` (the `@` in the
   user name written as `%40`). Mail is sent from that account.
   ```sh
   firebase functions:secrets:set ALLOWLIST_ALERT_SMTP_URL --project <project>
   ```
   The secret must exist before the next deploy: the deploy refuses a function
   whose secret is missing. To deploy without alerts, set it to any value (for
   example `none`) and leave the recipient empty.
2. **Set the recipient**, `ALLOWLIST_ALERT_TO`, in `functions/.env.<project>`
   (for example `ALLOWLIST_ALERT_TO=you@example.com`), or answer the prompt an
   interactive `firebase deploy` shows. It defaults to empty. CI deploys
   non-interactively, so for alerts to survive its deploys the file has to be
   committed, and this repository is public: use an address you are happy to
   publish, such as an alias.
3. Deploy (`bun run deploy`). The deploy credential needs to be able to grant
   the function access to the secret (Secret Manager Admin, or Owner).

**Turning alerts off:** clear the recipient (`ALLOWLIST_ALERT_TO=`) and deploy.
With either the recipient or the secret empty the function logs
`allowlist alert skipped: not configured` and sends nothing.

## Locally, against the emulator

`bun run firebase:emulator` builds and runs the functions too, so the emulator
refuses an unlisted address just as production does. Put yourself on the list
with the same script, pointed at the emulator:

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
  FIREBASE_PROJECT_ID=demo-solid-groove bun run allowlist:add -- you@example.com
```

## Signing CI in as a QA account

CI signs into the live app as a standing pool of allowlisted QA accounts
(#1055): `testuser0`…`testuser10@qa.trygroove.app`, UIDs `qa-testuser-<n>`,
each with a verified address on a domain that receives no mail. `testuser0` is
the post-deploy smoke test's; `testuser1`…`testuser10` are the QA sweep's,
one per agent slot. The pool is written down once, in `src/access/qaAccounts.ts`.

There is no new sign-in method. A dedicated service account signs a Firebase
custom token for one of the accounts; the hosted suites exchange it for a
session in Node with the Firebase client SDK and write that session into the
page's IndexedDB, the way the emulator suite installs its sessions. Nothing in
the app's bundle knows about any of it. The session is stored under the
build's web API key: the deploy and preview jobs pass the
`VITE_FIREBASE_API_KEY` variable the build used, and the QA sweep, which does
not run in the `prod` environment that variable lives in, reads the key from
the site's own `/__/firebase/init.json` (checked to match the live bundle's
when this was built).

**The allowlist gate does not run for these sign-ins.** Firebase never runs a
blocking function for a custom-token sign-in ("Anonymous and custom
authentication do not trigger blocking functions",
[Firebase docs](https://firebase.google.com/docs/auth/extend-with-blocking-functions)),
so `alphaAllowlistGate` is never asked about a QA account. Only the holder of
the service account's key can mint a token, which is what keeps this closed.
The accounts are on the allowlist anyway, verified, so they would pass the gate
if Firebase ever did run it (`providerId` would be `custom`, so the gate would
rely on `emailVerified`), and so they show on `/admin` as the people who can
sign in.

`<project>` below is the production Firebase project ID (the
`FIREBASE_PROJECT_ID` repository variable). The sweep and the signed-in smoke
test cannot pass until steps 1 to 3 are done.

### 1. Create the service account

With `gcloud`, signed in as a project owner:

```sh
gcloud iam service-accounts create qa-sign-in \
  --project=<project> \
  --display-name="QA sign-in (custom tokens for CI QA accounts)"
```

Or in the Google Cloud console: IAM & Admin → Service accounts → Create
service account, name `qa-sign-in`. **Grant it no roles.** It only signs
custom tokens with its own key, which needs no IAM permission. It is not
`FIREBASE_DEPLOY_SERVICE_ACCOUNT`: a leaked key can sign in as a QA user and
nothing more.

### 2. Make a key and save it as a GitHub secret

```sh
gcloud iam service-accounts keys create qa-sign-in.json \
  --iam-account=qa-sign-in@<project>.iam.gserviceaccount.com
gh secret set QA_SIGN_IN_SERVICE_ACCOUNT --repo trygroove/groove < qa-sign-in.json
rm qa-sign-in.json
```

Or in GitHub: Settings → Secrets and variables → Actions → New repository
secret, name `QA_SIGN_IN_SERVICE_ACCOUNT`, value is the whole JSON file.
Delete the local file afterwards; the secret is the only copy.

If key creation is refused, the organisation policy
`iam.disableServiceAccountKeyCreation` is on. Allow it for this project, or
say so on #1055 so the build can switch to keyless signing (Workload Identity
Federation plus the `iam.serviceAccounts.signBlob` permission).

### 3. Create the QA accounts

With application default credentials for an owner
(`gcloud auth application-default login`):

```sh
FIREBASE_PROJECT_ID=<project> bun run qa:accounts
```

It creates or updates `testuser0`…`testuser10@qa.trygroove.app` (UIDs
`qa-testuser-<n>`, email verified, display name `QA testuser<n>`) and adds each
address to the allowlist. Running it again changes nothing. It never grants
`admin`, and it leaves a disabled account disabled. The accounts show on
`/admin` in the allowlist; don't remove them there.

### 4. Check it

Actions → QA sweep → Run workflow with `dry_run` on. The run walks a flow as
`testuser1` and reports a real build SHA in the run's job summary (a dry
run posts no project update). The next deploy's smoke test creates and
plays a project as `testuser0`.

### Rotating or revoking

- **Rotate the key:** make a new key (step 2), update the secret, then delete
  the old key:
  `gcloud iam service-accounts keys list --iam-account=qa-sign-in@<project>.iam.gserviceaccount.com`,
  then `keys delete <id>`.
- **Suspected leak:** delete the key straight away. That stops new sign-ins.
  To end sessions already open, revoke the QA users' refresh tokens
  (`auth.revokeRefreshTokens(uid)`) or disable them in Authentication → Users.

## What signs in without a person

Guest start was what let automation into the live app without an account.
With it gone, CI signs in as the QA accounts instead (see "Signing CI in as a
QA account" above):

- **The post-deploy smoke test** (`tests/e2e/hosted/smoke.spec.ts`, run by the
  `deploy` job and on previews) checks the landing page, that `/projects` keeps
  a visitor with no session out, and the not-on-the-list page, then signs in
  as `testuser0`, creates a project, plays it, and deletes that one project.
  It deletes only the project it made, by its ID, because the deploy and
  several previews can be signed in as `testuser0` at once. Without the
  `QA_SIGN_IN_SERVICE_ACCOUNT` secret (a fork's pull request) the signed-in
  test skips and says so.
- **The scheduled QA sweep** (`tests/e2e/hosted/qa-sweep/`) signs each agent
  in as its own QA account, `testuser1`…`testuser10`, and deletes that
  account's projects when the agent is done.
- **The QA accounts are internal traffic**: `bun run qa:accounts` gives each
  one the `internal` claim (see "Internal accounts" below), and the suites'
  first page load carries `?internal=1` as well, so they never count in the
  product's measures.
