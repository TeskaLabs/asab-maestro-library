# Changelog

## Unreleased

Changes on `main` that are not on `release/v26.37` yet.

### Breaking changes

- ASAB services bind HTTP APIs on `{{INTERNAL_NETWORK_IP}}` only (Governator, Remote Control, Library, Iris, Config, Discovery, Lighthouse, Pyppeteer, BS Query; SeaCat Auth `web` and `web:public`). ([#315](https://github.com/TeskaLabs/asab-maestro-library/pull/315))

---

## v26.37

Tag [`v26.37.01`](https://github.com/TeskaLabs/asab-maestro-library/releases/tag/v26.37.01) points at `release/v26.37`.

### Breaking changes

- Web applications are served from the internal NGINX listener on `{{INTERNAL_NETWORK_IP}}:8890`; `LogMan.io WebUI.yaml` and `SeaCat Auth WebUI.yaml` were removed from `Site/ASAB Maestro/WebApps/`. LogMan.io WebUI is distributed via LMIO. ([#289](https://github.com/TeskaLabs/asab-maestro-library/pull/289), [#297](https://github.com/TeskaLabs/asab-maestro-library/pull/297), [#298](https://github.com/TeskaLabs/asab-maestro-library/pull/298))
- Third-party container images are pulled from `pcr.teskalabs.com` instead of Docker Hub (NGINX, MongoDB, Elasticsearch, Grafana, Kafka stack, SeaCat Auth, and others). ([#291](https://github.com/TeskaLabs/asab-maestro-library/pull/291))
- ASAB Pyppeteer: `url_white_list` defaults to `http://nginx:8890` instead of `{{PUBLIC_URL}}`; JWT validation via SeaCat Auth added. ([#305](https://github.com/TeskaLabs/asab-maestro-library/pull/305))
- MongoDB: `maxIncomingConnections` reduced from 120000 to 5000; memory capped at 2 GB with swap disabled. ([#299](https://github.com/TeskaLabs/asab-maestro-library/pull/299))
- Elasticsearch: memory lock enabled, swap disabled (`mem_swappiness: 0`). ([#265](https://github.com/TeskaLabs/asab-maestro-library/pull/265))
- ASAB Remote Control: removed default ASAB Config seed `Library/config.json` pointing at the maestro-library git provider; library providers must be configured explicitly in the model. ([#314](https://github.com/TeskaLabs/asab-maestro-library/pull/314) on `release/v26.37`, [#310](https://github.com/TeskaLabs/asab-maestro-library/pull/310) on `main`)

### Features

- New AWS CLI descriptor (`amazon/aws-cli` sleep container with optional `~/.aws` config and read-only slow storage mount). ([#308](https://github.com/TeskaLabs/asab-maestro-library/pull/308) on `main`; backported to `release/v26.37`, volume layout as in [#316](https://github.com/TeskaLabs/asab-maestro-library/pull/316))
- New descriptor for ASAB Lighthouse (internal web UI, tenant-aware auth). ([#290](https://github.com/TeskaLabs/asab-maestro-library/pull/290))
- ASAB Governator: mount the host container socket from model parameter `{{DOCKER_SOCKET}}` (Docker or Podman) instead of a hard-coded `/var/run/docker.sock`. ([#319](https://github.com/TeskaLabs/asab-maestro-library/pull/319) on `release/v26.37`, [#318](https://github.com/TeskaLabs/asab-maestro-library/pull/318) on `main`)
- ASAB Governator: per-instance NGINX locations for `/api/{{INSTANCE_ID}}/export-download` (public and internal). ([#287](https://github.com/TeskaLabs/asab-maestro-library/pull/287), [#292](https://github.com/TeskaLabs/asab-maestro-library/pull/292))
- ASAB Iris: Mattermost notification channel and ASAB Config schema; shared library cache volume and tenant URL. ([#304](https://github.com/TeskaLabs/asab-maestro-library/pull/304))
- Shared read-only library provider cache (`{{SLOW_STORAGE}}/library/cache`) for ASAB Library, Remote Control, Iris, and BS Query. ([#293](https://github.com/TeskaLabs/asab-maestro-library/pull/293))
- MongoDB: arbiter node support in `mongo-init.js` (add arbiter, convert core node to arbiter). ([#286](https://github.com/TeskaLabs/asab-maestro-library/pull/286))
- ZooKeeper: dynamic reconfiguration sherpa (`reconfig.py`) and startup script updates. ([#295](https://github.com/TeskaLabs/asab-maestro-library/pull/295))
- NGINX `webapp-dist.sh`: multiple fallback distribution URLs, shuffled URL order, clearer download errors. ([#306](https://github.com/TeskaLabs/asab-maestro-library/pull/306))
- Grafana: new `raid-overview` system dashboard. ([#278](https://github.com/TeskaLabs/asab-maestro-library/pull/278))
- Elasticsearch Telegraf input: collect selected `node_stats` instead of heavy default metrics. (commit `63d33f0`)

### Bug fixes

- ASAB Governator NGINX export routing adjustments after integration testing. ([#288](https://github.com/TeskaLabs/asab-maestro-library/pull/288))
- ZooKeeper JVM heap increased to 2 GB. ([#300](https://github.com/TeskaLabs/asab-maestro-library/pull/300))
- SeaCat Auth descriptor image registry aligned with `pcr.teskalabs.com`. (in [#291](https://github.com/TeskaLabs/asab-maestro-library/pull/291))
