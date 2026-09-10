---
okf_version: "0.1"
conqrse_siblings:
  - name: aeo-backend
    path: ../aeo-backend
  - name: conqrse-queue
    path: ../conqrse-queue
  - name: configurable-prospect-scanner
    path: ../configurable-prospect-scanner
---

# OKF Bundle — aeo-competitor-resolution-runtime

Open Knowledge Format bundle for this repo. Start at [service.md](/service.md).

## Siblings, and what each one is to this repo

- **`aeo-backend`** owns the client's watchlist — the tables this runtime reads its
  input from and writes its findings back to, through that repo's runtime-callback
  controller. It also owns the portal API that triggers a run. This runtime holds
  **no** database schema of its own.
- **`conqrse-queue`** dispatches this runtime as an isolated Kubernetes Job, keyed
  by a catalog `taskRef`. ⚠️ **It is ours to use, not ours to change** — no bundle,
  no gate and no CI from us, and nothing is pushed to it. Registering this image in
  its catalog is a database write through its API, not a code change.
- **`configurable-prospect-scanner`** is the working precedent for the shape of
  this repo: a containerised worker, digest-pinned in the queue catalog, built by
  hand because its CI builds no image.

## What this repo deliberately is not

It is **not** a scraper for one retailer. Retailer capability is read from a
registry in `aeo-backend`, and every retailer-varying behaviour sits behind the
adapter seam. **No customer and no retailer is named in a code path** — that is the
change's exit criterion, not a style preference, and the reason is that the second
real retailer is what teaches the abstraction's shape. Nobody has looked at one yet.
