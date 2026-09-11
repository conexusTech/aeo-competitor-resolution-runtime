# The image the queue runs as an isolated Kubernetes Job.
#
# ⚠️ Build for linux/amd64 explicitly. The cluster's nodes are amd64, and an
# arch mismatch fails INSIDE the Job rather than at build time — the sibling
# scanner's runbook records that as a real cost.
#
#   docker buildx build --platform linux/amd64 \
#     -t <ecr>/aeo-competitor-resolution-runtime:<short-sha> --push .
#
# Production pins by DIGEST, not by tag, so re-tagging cannot silently change
# what runs — and a catalog update therefore requires a pushed image first.
#
# ── What the catalog entry must declare ────────────────────────────────
# The queue injects exactly ONE variable, TASK_RECORD_ID, and keeps the job in
# the portal's database. Everything else arrives through `envFrom`, and a run
# refuses at START rather than after spending if any of it is missing:
#
#   QUEUE_API_URL                    where to read the task record back from
#   RESOLUTION_GATEWAY_URL           the gateway's base url
#   RESOLUTION_GATEWAY_USER          Basic auth, the same credential the
#   RESOLUTION_GATEWAY_PASSWORD      other /runtime/* routes use
#   BRIGHTDATA_API_KEY               the proxy
#   BRIGHTDATA_UNLOCKER_ZONE
#
# 🔴 A PARTIAL catalog PUT silently nulls `envFrom`. The queue's `upsert` merges
# and then forces `command`, `envFrom`, `namespace`, `payloadFields` and
# `serviceAccountName` to null when absent from the payload — so `{image}`
# alone would strip every variable above and every run would refuse. GET the
# entry, change the one field, PUT the whole thing back, then diff every field
# against the GET: a 200 is not evidence.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Traceability: stamped at build so a running container resolves to a pushed
# commit. The sibling runtimes learned this the expensive way — a deployment
# record that drifted two versions mis-sized a deploy by nine commits.
ARG BUILD_VERSION=unknown
ENV RESOLUTION_BUILD_VERSION=${BUILD_VERSION}

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The committed replay corpus, so RESOLUTION_REPLAY_CORPUS can name a path
# inside the image.
#
# ⚠️ **~1 MB, and it ships in every image on purpose.** The queue's catalog
# entry declares no volumes — command, resources, retry, timeoutSec, namespace,
# envFrom, payloadFields and serviceAccountName, and nothing else — so there is
# no way to mount a corpus into a dispatched Job. Baking it in is the only
# shape that lets the dispatch path be exercised without a paid credential.
#
# 🔴 It changes nothing about a normal run: replay is selected only by an
# explicit env var, the live path is what an absent one gets, and a replayed
# run stamps "+replay" into the runtime_version the gateway persists. The bodies
# are public retailer pages already committed to this repo, so shipping them
# discloses nothing new.
COPY test/corpus ./corpus

# Not root. The run writes only its journal and response cache, both mounted.
RUN addgroup -S runner && adduser -S runner -G runner \
 && mkdir -p /app/runs /app/captures \
 && chown -R runner:runner /app/runs /app/captures
USER runner

ENV RESOLUTION_RUN_DIR=/app/runs
ENV RESOLUTION_CACHE_DIR=/app/captures

ENTRYPOINT ["node", "dist/main.js"]
