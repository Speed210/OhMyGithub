# Operate OpenCode execution

Use OpenCode v2. Keep the project owner’s source, conversation history, and generated builds in the project repository. Keep the GitHub App responsible for listener installation; prepare and execute issues in Actions.

## Prefer Fusion

Resolve the current `main` commit for `opencode-copilot-fusion` when `FUSION_ACCESS_TOKEN` exists. Install that exact SHA and record it in `FUSION_PLUGIN_COMMIT`, `fusion-plugin-commit.txt`, `opencode-run.log`, the issue access comment, and the log release. Prepend `copilot-fusion-direct/fusion` to the default model chain only when the SHA resolved. Advance to free models on Fusion auth, quota, route, or gateway failures. Keep explicit `model/*` labels single-model. Let OmGithub supply the signed-in account token through account credentials.

## Select execution

Create an issue with the OpenCode label attached. Freeze its request, branch, and source commit during preparation. Keep the user request unchanged. Select branches through omgithub-request:v1 metadata. Serialize runs per issue. Install a current listener before requesting execution.

## Start workers

Resolve and install the latest stable v2 runtime for every run. Attempt conversation import on that runtime. Keep the saved code and start a fresh chat when conversation restoration fails. Record the actual installed version in checkpoints. Run startup.sh once for project prerequisites. Run start.sh in the foreground through the controller. Declare the built static directory inside PROJECT_DIR in deployment-output.json.

## Expose live services

Start one named Cloudflare Tunnel per run and attempt through the authenticated OmGithub callback. Route OC, Files, and Live through separate omgithub.com hostnames. Keep account management credentials on OmGithub. Pair browsers through /omgithub/connect. Keep the main session distinct from script-repair forks. Validate actual browser message submission, SSE, Files, and Live.

## Save checkpoints

Commit source and .omgithub/checkpoint.json on opencode-checkpoints/ISSUE. Include .omgithub/conversation.json when the complete main conversation fits within 100,000,000 bytes. Record its digest and skipped files. Keep checkpoint commits reachable. Push normally and reject superseded writes. Keep the workspace branch unchanged while saving. Restore exact pinned commits; start fresh when history is absent or oversized.

## Publish builds

Validate startup and capture through scripts/preview-setup.mjs. Repair project scripts in a fork only after failure. Use relative asset paths; configure Vite builds with a relative base. Commit unpacked static output and .omgithub/deployment.json on opencode-deployments/ISSUE. Upload final screenshots to OmGithub as WebP. Keep source and build commit identities separate. Capture the exact immutable f.ondev.store URL before activating its catalog record. Preserve the previous playable deployment when validation fails.

## Publish progress images

Upload progress captures to OmGithub every two seconds. Compress them to WebP when smaller and register immutable OmGithub URLs. Keep old hosted screenshot readers available.

## Resume and remix

Restore source independently of conversation history. Preserve source attribution, licenses, repository references, and the selected commit. Copy source into the destination through scripts/remix-snapshot.mjs when necessary. Use the current runtime and listener for new work. Keep existing published games available.

## Inspect workers

Read lifecycle.log and deployment-status.json over SSH before interpreting public readiness. Use scripts/ssh-run-log.sh for active runs. Read completed logs through GitHub. Inspect source checkpoints, immutable build URLs, and diagnostics separately. Export diagnostic responses through the v2 API.

## Clean up

Stop the lifecycle and connector. Remove execution tunnel and DNS resources. Reconcile abandoned tunnels through the server journal. Preserve existing hosted builds, screenshots, recordings, and source references. Remove server conversation payloads only after verifying the Git-backed restore path.

## Import Console device credentials

Run `account-credentials.mjs install-console` after the V2 server becomes healthy and before starting model work. Import the account's Console OAuth credential through `/api/credential` with method `device` and workspace metadata. Remove only the matching legacy duplicate. Start the account synchronization watcher after native import so it inherits the server port and password. Read refreshed Console tokens from `/api/credential`; retain other providers' existing synchronization behavior. Stop uploads after a revision conflict and preserve the active native connection until final cleanup.

Run `node --test scripts/console-credentials.test.mjs`. Run the account credential tests relevant to load, cleanup, concurrency, MCP, and provider merging. Run `node scripts/test-console-runtime.mjs` against an isolated latest-stable OpenCode v2 server with an explicitly authorized Console test token file. Keep the token file private and remove it after verification.

## Continue with optional history

Restore pinned source code when continuing. Import conversation history only when resume metadata sets `import_history` to `true`. Otherwise skip conversation download and start a fresh chat. Retain fresh-chat fallback when an enabled import fails.

## Report overloaded service

Show “We’re running low on spare robot brains. Please try again in a moment!” for free-model quota failures. Retain distinct messages for other provider failures.

## Bound Linux package setup

Force IPv4 for worker APT downloads. Limit mirror waits to twenty seconds and one retry. Limit the index refresh to three minutes and Linux browser setup to eight minutes. Inspect package setup when a worker never publishes SSH or chat links; these links start after browser installation.

Preserve the issue account and MCP selection when recovering an existing issue with a new runtime pin. Update its issue-specific credential authorization to the same runtime before restarting; changing only the listener causes account credential loading to return HTTP 403.

## Enable account debugging

Load account credentials before SSH startup. Use the issue-authorized default public key only when Debug mode was enabled at issue creation and the repository key is absent. Preserve configured repository keys. Start SSH before package installation. Keep private keys outside Actions.


## Fusion large files and compaction budget

Load the bundled `scripts/opencode-plugins/fusion-policy` promise plugin after the Copilot Fusion plugin. It adds Fusion-only system/tool guidance: write a working skeleton, then focused edits or append chunks of at most 12,000 characters, never repeat a truncated giant write. Foreground compaction has a hardcoded three-request/five-minute operation budget, logs attempts explicitly, and returns a visible non-retryable error when exhausted. Keep experimental background compaction disabled for this policy. Ordinary primary retries are not suppressed by a previous operation. The model output limit remains 8,000 pending genuine upstream budget verification.

Validate with `node --test scripts/opencode-plugins/fusion-policy/policy.test.mjs` and the checkpoint/build/lifecycle/preparation/reporting tests. Publishing main makes the policy available to newly resolved immutable central workflow SHAs; existing running jobs stay pinned to their original runtime commit. Roll back a published policy with a normal revert commit, never a force-push.

Shared-pool policy tags primary/title/compaction/generate only for the configured shared proxy origin. The proxy strips this routing hint upstream; title/generate prefer another healthy contributor. Direct own-token requests and other services receive no hint. Fusion is pinned to `git+https://github.com/denaidark/opencode-copilot-fusion.git#16f95e0472ccbde1f3951f00765f1751ba4db80d`. It routes title/generate/compaction through the separate free auxiliary service, keeps primary routes sticky (reset on compaction), defaults to balance tier and clamps output to the selected model cap from the proxy. Luna currently reports 128000; this is not a universal cap. Initial native requests can retain the conservative 64000 budget; lower requested/model budgets remain lower.
