# Phase 2B — key lifecycle and security disclosure

PROTOCOL_2B §Key lifecycle requires: a fresh key created immediately
before the keyed smoke, and post-campaign revocation confirmed by a
recorded 401 check before the evidence bundle is built. Both held. One
security deviation occurred and is disclosed in full below; it is a
credential-hygiene deviation, not an evidence-integrity one, and it is
for the external auditor to adjudicate explicitly.

## Timeline (2026-07-26/27, UTC)

1. **Old Phase-2A key revoked** (operator, Anthropic console) before
   any Phase-2B trial. Confirmed by a status-code-only API check
   returning **HTTP 401**, recorded in the session transcript minutes
   before the keyless arm launched (first keyless bench
   `22:25:13Z`). `.env` was then blanked and a child-process check
   confirmed no key and no `STAGEHAND_MODEL` reached campaign code
   (`loadAgentEnvConfig → modelProvider: null, stagehandModel: null`).
2. **Keyless arm** ran entirely without credentials (30 entries,
   `spendUsd = 0`; the driver refuses the keyless phase if any key or
   model variable is set).
3. **Fresh key created** by the operator immediately before the keyed
   phase (validity confirmed by a status-code-only check returning
   HTTP 200 at ~`22:58Z`; first paid call was the keyed smoke,
   ~`23:00Z`).
4. **Keyed phase** ran ~`23:00–23:57Z`; total recorded spend
   **$2.0889** (see VERIFICATION.md).
5. **Fresh key revoked** by the operator immediately after the gate-7
   verification checks passed. Recorded 401 check:
   **`2026-07-27T00:29:38Z` — HTTP 401** (`GET /v1/models`,
   status-code-only, credential extracted from `.env` without being
   displayed). `.env` was then blanked again and the child-process
   check re-confirmed a clean environment.

## Security deviation: transcript exposure of the fresh key

The fresh key was **pasted by the operator into the working chat
transcript** before first use — the same exposure class that forced the
old Phase-2A key's revocation. The assistant refused to use it and
requested a replacement; the operator explicitly accepted the risk
twice and directed its use. It was used on that authority, under three
conditions applied at the time: this disclosure would be made to the
auditor; the protocol's revocation-before-bundling requirement would be
enforced without deferral (it was — item 5 above); and the key would
receive minimal handling (it entered only the gitignored `.env`; every
check on it was status-code-only).

**Exposure window:** ~90 minutes from paste to confirmed revocation,
during which the campaign itself was executing.

**Never committed:** `.env` has never been tracked (`git ls-files
.env` is empty); a git-history search for the key returns 0 commits;
the only tracked file matching the generic `sk-ant-api03` prefix is
`tests/integration/decoy-canary.test.ts`, whose constant is the
documented Phase-2A fake-key canary (`…CANARYCANARY…`) and does not
contain the real key's bytes.

**Why this does not touch evidence integrity:** the evidence is graded
from raw payloads shipped inside the trial records and re-derived by
the verifier; the ledger banks token counts returned in the runner's
own API responses, never account-level billing (PROTOCOL_2B: the stop
threshold is "never a bound or a billing reconciliation"). A third
party holding the key during the window could have spent the
operator's account balance but could not have altered local trial
records, the frozen suite, or the ledger's accounting.

**Provider-usage reconciliation:** available on request from the
operator's Anthropic console (compare account usage for the window
against the recorded $2.0889); not performed here because the protocol
excludes billing reconciliation from the accounting boundary. The
auditor may request it.
