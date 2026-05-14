const fs = require("fs")

/**
 * Replica set reconcile (primary only), driven by replica-set.json from remote-control.
 *
 * Flows covered:
 * 1) New peripheral / arbiter — host in desired, not in live set → wait for mongod → rs.add / rs.addArb.
 * 2) Mongo removed from a node — host absent from desired but still in live set → rs.remove (never remove
 *    current primary host; cluster must keep ≥1 data member in desired). Removing the last arbiter leaves a
 *    single data member; Mongo may sit with no PRIMARY until an election — ensurePrimaryWhenSoleDataMember
 *    (and the main-loop recovery path) run replSetStepUp when needed.
 * 3) New core (data) node — rs.add when safe. If the live set is exactly one data member + ≥1 arbiter (PSA-style)
 *    and you add another electable data member, MongoDB rejects plain rs.add/rs.reconfig (NewReplicaSetConfigurationIncompatible);
 *    use rs.reconfigForPSASet(memberIndex, cfg) with the full merged config (see addMissingMembers).
 * 4) Node role change (arbiter ↔ data) — never flip arbiterOnly in place. Data→arbiter: script may rs.remove
 *    then you wipe dbPath and re-run so add-missing re-adds as arbiter. Arbiter→data: NOT automated — the script
 *    fails fast before any replica-set mutation (see assertArbiterToDataRequiresManual); you rs.remove, wipe
 *    dbPath, restart, then re-run init.
 *
 * Phase order in reconfigureReplicaSet(): (0) assert no arbiter→data pending (1) CWWC (2) decommission
 * (3) data→arbiter remove (4) add missing (5) rs.reconfig sync (6) sole-data-member PRIMARY election assist.
 *
 * --- Break-glass: mongod crash loop (OplogApplier / enableMajorityReadConcern invariant on MongoDB 7.x) ---
 * This script only runs while mongod stays up. A looping member has INVALID local data (typical: promoted
 * arbiter or role change without wiping dbPath). Logs show stale local repl config (e.g. setVersion 214988)
 * while primary is much newer, "No initial sync required" + immediate abort.
 *
 * Fix (operator, on the BROKEN host — e.g. mongo-2 / ples01-mongo-arb):
 *  A) On a HEALTHY primary (mongosh): rs.status() / rs.conf(). If the broken host is still listed,
 *     rs.remove("host:27017") so the cluster stops expecting that mongod.
 *  B) Stop the broken mongod container/service (so it does not restart-crash forever).
 *  C) Delete ALL files under that instance's dbPath (e.g. /data/db including WiredTiger*, local/, journal).
 *     Docker: stop container, docker run --rm -v that_volume:/data/db busybox rm -rf /data/db/*
 *  D) Start mongod again with empty dbPath — it should NOT load old repl config; it may show as standalone
 *     or await rs.add.
 *  E) From primary: rs.add({ host: "...", ... }) or re-run this init against primary so the add-missing phase runs.
 *
 * Do not partially delete files; partial wipe keeps the crash. Optional last resort to get a shell on bad
 * data (not a substitute for wipe): start mongod once with setParameter enableMajorityReadConcern=false
 * (see MongoDB manual), then still plan a full wipe + rejoin.
 */

/**
 * Cluster-wide default write concern (MongoDB 5.0+ gate before many reconfigs).
 * Optional: MONGO_INIT_DEFAULT_WRITE_CONCERN_W — "majority" (default), "1", "2", etc.
 * Use w=1 only when you accept weaker defaults (e.g. temporary 1 data + 1 arbiter).
 * @see https://www.mongodb.com/docs/manual/reference/command/setDefaultRWConcern/
 */
function defaultWriteConcernFromEnv() {
	const w = process.env.MONGO_INIT_DEFAULT_WRITE_CONCERN_W
	if (w == null || String(w).trim() === "" || String(w).trim() === "majority") {
		return { w: "majority", wtimeout: 0 }
	}
	const n = parseInt(String(w), 10)
	if (!isNaN(n)) {
		return { w: n, wtimeout: 0 }
	}
	return { w: String(w).trim(), wtimeout: 0 }
}

function ensureClusterWideDefaultWriteConcern() {
	const dwc = defaultWriteConcernFromEnv()
	const res = db.adminCommand({
		setDefaultRWConcern: 1,
		defaultWriteConcern: dwc,
		writeConcern: { w: "majority", wtimeout: 15000 },
	})
	if (!res.ok) {
		const msg = res.errmsg != null ? res.errmsg : JSON.stringify(res)
		throw new Error("setDefaultRWConcern failed: " + msg)
	}
	print("setDefaultRWConcern: defaultWriteConcern " + JSON.stringify(dwc) + " (ok)")
}

function normalizeMemberHost(host) {
	return typeof host === "string" ? host.trim() : host
}

/**
 * rs.add / rs.addArb require the new member's mongod to already accept connections.
 * Init often races the arbiter container: wait until ping succeeds.
 * Env: MONGO_INIT_PEER_WAIT_ATTEMPTS (default 60), MONGO_INIT_PEER_WAIT_MS (default 5000).
 */
function peerWaitConfigFromEnv() {
	const attempts = parseInt(process.env.MONGO_INIT_PEER_WAIT_ATTEMPTS || "60", 10)
	const ms = parseInt(process.env.MONGO_INIT_PEER_WAIT_MS || "5000", 10)
	return {
		attempts: isNaN(attempts) ? 60 : Math.max(1, attempts),
		ms: isNaN(ms) ? 5000 : Math.max(200, ms),
	}
}

function waitForMongodOnHost(hostPort) {
	const hp = normalizeMemberHost(hostPort)
	const { attempts, ms } = peerWaitConfigFromEnv()
	let lastMsg = ""
	for (let a = 1; a <= attempts; a++) {
		try {
			if (typeof Mongo === "undefined") {
				throw new Error("Mongo constructor unavailable in this shell")
			}
			const conn = new Mongo(hp)
			const ping = conn.getDB("admin").runCommand({ ping: 1 })
			if (ping.ok === 1) {
				print("mongod reachable at " + hp + " (attempt " + a + "/" + attempts + ")")
				return
			}
			lastMsg = "ping ok !== 1: " + JSON.stringify(ping)
		} catch (e) {
			lastMsg = e.message
		}
		if (a < attempts) {
			print("Waiting for mongod at " + hp + " (" + a + "/" + attempts + "): " + lastMsg)
			sleep(ms)
		}
	}
	throw new Error(
		"Timed out waiting for mongod at " +
			hp +
			". Ensure the member container starts before init runs rs.add (compose depends_on / order), or increase MONGO_INIT_PEER_WAIT_ATTEMPTS. Last error: " +
			lastMsg
	)
}

function currentMembersByHost(conf) {
	const map = {}
	for (const mem of conf.members) {
		map[normalizeMemberHost(mem.host)] = mem
	}
	return map
}

function desiredHostSet(desired) {
	return new Set(desired.members.map((dm) => normalizeMemberHost(dm.host)))
}

/** Voting data members in desired config (excludes arbiters). */
function desiredDataMemberCount(desired) {
	let n = 0
	for (const dm of desired.members) {
		if (dm.arbiterOnly !== true) {
			n++
		}
	}
	return n
}

/** Non-arbiter members in a live rs.conf() (same notion as desiredDataMemberCount). */
function dataMemberCountFromConf(conf) {
	let n = 0
	for (let i = 0; i < conf.members.length; i++) {
		if (conf.members[i].arbiterOnly !== true) {
			n++
		}
	}
	return n
}

function arbiterMemberCountFromConf(conf) {
	let n = 0
	for (let i = 0; i < conf.members.length; i++) {
		if (conf.members[i].arbiterOnly === true) {
			n++
		}
	}
	return n
}

/** Live set is one data-bearing member and at least one arbiter (PSA transition source topology). */
function isOneDataPlusArbiterTopology(conf) {
	return dataMemberCountFromConf(conf) === 1 && arbiterMemberCountFromConf(conf) >= 1
}

function missingDataMemberHostsFromMap(desired, curMap) {
	const out = []
	for (let i = 0; i < desired.members.length; i++) {
		const dm = desired.members[i]
		if (dm.arbiterOnly === true) {
			continue
		}
		const h = normalizeMemberHost(dm.host)
		if (!curMap[h]) {
			out.push(h)
		}
	}
	return out
}

function findMemberIndexByHost(members, host) {
	const h = normalizeMemberHost(host)
	for (let i = 0; i < members.length; i++) {
		if (normalizeMemberHost(members[i].host) === h) {
			return i
		}
	}
	return -1
}

function rsStatusHasPrimary(st) {
	for (let i = 0; i < st.members.length; i++) {
		if (st.members[i].stateStr === "PRIMARY") {
			return true
		}
	}
	return false
}

/**
 * After decommission (e.g. mongo removed from the arbiter host), the survivor can remain SECONDARY with no
 * PRIMARY until an election completes — or never, until replSetStepUp. Only safe when rs.conf() has exactly
 * one data-bearing member and desired matches (one data member).
 */
function ensurePrimaryWhenSoleDataMember(desired) {
	const conf = rs.conf()
	if (dataMemberCountFromConf(conf) !== 1 || desiredDataMemberCount(desired) !== 1) {
		return
	}
	const pollAttempts = parseInt(process.env.MONGO_INIT_SOLE_PRIMARY_POLL_ATTEMPTS || "8", 10)
	const pollMs = parseInt(process.env.MONGO_INIT_SOLE_PRIMARY_POLL_MS || "1500", 10)
	const maxPoll = isNaN(pollAttempts) ? 8 : Math.max(1, pollAttempts)
	const ms = isNaN(pollMs) ? 1500 : Math.max(200, pollMs)
	for (let k = 0; k < maxPoll; k++) {
		const st = rs.status()
		if (rsStatusHasPrimary(st)) {
			if (k > 0) {
				print("[sole data member] PRIMARY appeared after wait")
			}
			return
		}
		if (k + 1 < maxPoll) {
			print(
				"[sole data member] no PRIMARY yet (" + (k + 1) + "/" + maxPoll + "); sleeping " + ms + "ms"
			)
			sleep(ms)
		}
	}
	print("[sole data member] still no PRIMARY; running replSetStepUp on this mongod")
	const r = db.adminCommand({ replSetStepUp: 1 })
	if (r.ok === 1) {
		print("[sole data member] replSetStepUp ok")
		return
	}
	const msg = r.errmsg != null ? String(r.errmsg) : JSON.stringify(r)
	const benign =
		r.code === 95 ||
		r.codeName === "AlreadyPrimary" ||
		/already primary|NotSecondary|not electable|NodeNotElectable/i.test(msg)
	if (!benign) {
		print("[sole data member] replSetStepUp: " + msg + " (codeName=" + (r.codeName != null ? r.codeName : "") + ")")
	}
}

/** Host:port of the member this shell is connected as (primary when reconfigure runs). */
function connectedMemberHost() {
	try {
		const st = rs.status()
		for (let i = 0; i < st.members.length; i++) {
			if (st.members[i].self) {
				return normalizeMemberHost(st.members[i].name)
			}
		}
	} catch (e) {
		print("connectedMemberHost: could not read rs.status: " + e.message)
	}
	return null
}

/**
 * Flow 2: mongo instance removed from cluster model — host no longer in replica-set.json.
 * Remaining desired config must still list at least one data member; cannot remove this primary's host.
 */
function removeMembersDroppedFromDesired(desired, current) {
	if (desiredDataMemberCount(desired) < 1) {
		throw new Error("replica-set.json must keep at least one data (non-arbiter) member")
	}
	const wantHosts = desiredHostSet(desired)
	const selfH = connectedMemberHost()
	const toRemove = []
	for (const cm of current.members) {
		const h = normalizeMemberHost(cm.host)
		if (!wantHosts.has(h)) {
			toRemove.push(h)
		}
	}
	for (let i = 0; i < toRemove.length; i++) {
		const h = toRemove[i]
		print("[flow 2 decommission] Removing member not present in desired config: " + h)
		if (selfH !== null && h === selfH) {
			throw new Error(
				"Desired config omits the current primary host (" +
					h +
					"). Step down another primary first, or keep this member in replica-set.json until then."
			)
		}
		try {
			rs.remove(h)
		} catch (e) {
			print("rs.remove failed (may retry next init): " + e.message)
		}
	}
}

/**
 * Add one member from desired JSON (preserves _id when Mongo accepts it).
 */
function addMemberFromDesired(dm) {
	const h = normalizeMemberHost(dm.host)
	const doc = { host: h }
	if (dm._id !== undefined && dm._id !== null) {
		doc._id = dm._id
	}
	if (dm.arbiterOnly === true) {
		doc.arbiterOnly = true
	}
	if (dm.priority !== undefined) {
		doc.priority = dm.priority
	}
	if (dm.votes !== undefined) {
		doc.votes = dm.votes
	}
	const addRetries = parseInt(process.env.MONGO_INIT_RS_ADD_ATTEMPTS || "5", 10)
	const addDelayMs = parseInt(process.env.MONGO_INIT_RS_ADD_MS || "10000", 10)
	const maxTry = isNaN(addRetries) ? 5 : Math.max(1, addRetries)
	const delay = isNaN(addDelayMs) ? 10000 : Math.max(1000, addDelayMs)

	for (let t = 1; t <= maxTry; t++) {
		try {
			rs.add(doc)
			return
		} catch (e1) {
			let err = e1
			if (dm.arbiterOnly === true && t === 1) {
				try {
					print("rs.add with arbiterOnly failed, trying rs.addArb: " + err.message)
					rs.addArb(h)
					return
				} catch (e2) {
					err = e2
				}
			}
			const retryable =
				t < maxTry &&
				/Quorum check failed|Connection refused|NodeNotFound|timed out|Timeout/i.test(String(err.message))
			if (retryable) {
				print("rs.add retry " + t + "/" + maxTry + ": " + err.message)
				sleep(delay)
				continue
			}
			throw err
		}
	}
}

/**
 * Arbiter → data in one init pass is unsafe: rs.remove then rs.add while the peer still has arbiter-era
 * local/ on disk often produces MongoDB 7 crash loops until dbPath is fully wiped. We refuse before any
 * replica-set or CWWC mutation so the live set is unchanged.
 */
function assertArbiterToDataRequiresManual(desired, current) {
	const curMap = currentMembersByHost(current)
	const offenders = []
	for (const dm of desired.members) {
		const h = normalizeMemberHost(dm.host)
		const cm = curMap[h]
		if (!cm) {
			continue
		}
		const wantArbiter = dm.arbiterOnly === true
		const isArbiter = cm.arbiterOnly === true
		if (isArbiter && !wantArbiter) {
			offenders.push(h)
		}
	}
	if (offenders.length === 0) {
		return
	}
	throw new Error(
		"Refusing init: arbiter → data promotion is manual-only for: " +
			offenders.join(", ") +
			". Automated rs.remove + re-add in the same run leaves stale repl metadata on disk and can break that mongod until dbPath is fully deleted. " +
			"Do this, then re-run init: (1) On PRIMARY: rs.remove(\"host:port\") for each host above. " +
			"(2) On each former arbiter host: stop mongod, delete ALL files under dbPath, start mongod empty. " +
			"(3) Re-run init (rs.add happens in add-missing phase) or rs.add manually. " +
			"This run applied no replica-set or default RW concern changes."
	)
}

/**
 * Data-bearing member cannot become arbiter in place: remove from set first.
 * Operator must wipe dbPath and restart mongod; a later init pass adds the arbiter.
 */
function removeMembersForArbiterConversion(desired, current) {
	const curMap = currentMembersByHost(current)
	let removed = false
	for (const dm of desired.members) {
		const h = normalizeMemberHost(dm.host)
		const cm = curMap[h]
		if (cm && dm.arbiterOnly === true && cm.arbiterOnly !== true) {
			print("[flow 4 data→arbiter] Removing data member for arbiter conversion: " + h)
			print(
				"ACTION: stop mongod, EMPTY the full dbPath, restart — partial wipe causes broken repl state."
			)
			try {
				rs.remove(h)
				removed = true
			} catch (e) {
				print("rs.remove failed (member may already be absent): " + e.message)
			}
		}
	}
	return removed
}

function addMissingMembers(desired, current) {
	const curMap = currentMembersByHost(current)
	const live0 = rs.conf()
	const missingData0 = missingDataMemberHostsFromMap(desired, curMap)
	if (missingData0.length > 1 && isOneDataPlusArbiterTopology(live0)) {
		throw new Error(
			"Replica set has one data member and an arbiter; replica-set.json lists multiple new data members. " +
				"MongoDB requires rs.reconfigForPSASet once per added secondary. " +
				"Add at most one new data member per init pass, then re-run with the next host."
		)
	}
	for (const dm of desired.members) {
		const h = normalizeMemberHost(dm.host)
		if (!curMap[h]) {
			const flowTag = dm.arbiterOnly === true ? "[flow 1 new arbiter/peripheral]" : "[flow 3 new core data]"
			print(flowTag + " Adding replica set member: " + JSON.stringify(dm))
			waitForMongodOnHost(h)
			if (dm.arbiterOnly !== true) {
				const live = rs.conf()
				const missingData = missingDataMemberHostsFromMap(desired, curMap)
				if (missingData.length === 1 && isOneDataPlusArbiterTopology(live)) {
					print(
						"[flow 3 PSA] one data + arbiter: rs.reconfigForPSASet (https://www.mongodb.com/docs/manual/reference/method/rs.reconfigForPSASet/)"
					)
					if (typeof rs.reconfigForPSASet !== "function") {
						throw new Error(
							"rs.reconfigForPSASet is not available in this shell. Use mongosh on MongoDB 5.0+ to add an electable secondary to a 1-data+arbiter set."
						)
					}
					const newConfig = buildReconfigDocument(desired, live)
					const idx = findMemberIndexByHost(newConfig.members, h)
					if (idx < 0) {
						throw new Error("PSA reconfig: member index not found for host " + h)
					}
					rs.reconfigForPSASet(idx, newConfig)
				} else {
					addMemberFromDesired(dm)
				}
			} else {
				addMemberFromDesired(dm)
			}
			current = rs.conf()
			Object.assign(curMap, currentMembersByHost(current))
		}
	}
	return current
}

/**
 * Refuse full reconfig if any member would change arbiterOnly without having been removed first.
 */
function assertNoIllegalArbiterTransition(desired, current) {
	const curMap = currentMembersByHost(current)
	for (const dm of desired.members) {
		const h = normalizeMemberHost(dm.host)
		const cm = curMap[h]
		if (!cm) {
			continue
		}
		const wantArbiter = dm.arbiterOnly === true
		const isArbiter = cm.arbiterOnly === true
		if (isArbiter !== wantArbiter) {
			throw new Error(
				"Refusing rs.reconfig: cannot change arbiterOnly in place for " +
					h +
					" (live arbiterOnly=" +
					isArbiter +
					", desired=" +
					wantArbiter +
					"). Remove member, wipe dbPath, restart mongod, then re-run init."
			)
		}
	}
}

/**
 * Existing member: base document on live rs.conf() so votes/priority/buildIndexes/etc. are preserved.
 * replica-set.json is sparse (_id, host, arbiterOnly); rs.reconfigForPSASet rejects undefined votes.
 */
function mergeLiveMemberWithDesired(dm, cm) {
	const h = normalizeMemberHost(dm.host)
	const wantArbiter = dm.arbiterOnly === true
	const out = Object.assign({}, cm)
	out._id = cm._id
	out.host = h
	out.arbiterOnly = wantArbiter
	if (dm.priority !== undefined) {
		out.priority = dm.priority
	}
	if (dm.votes !== undefined) {
		out.votes = dm.votes
	}
	if (dm.tags !== undefined) {
		out.tags = dm.tags
	}
	if (dm.secondaryDelaySecs !== undefined) {
		out.secondaryDelaySecs = dm.secondaryDelaySecs
	}
	if (out.votes === undefined || out.votes === null) {
		out.votes = 1
	}
	if (out.priority === undefined || out.priority === null) {
		out.priority = wantArbiter ? 0 : 1
	}
	return out
}

/** New member not in the live set yet — explicit votes/priority required by mongosh PSA reconfig. */
function newMemberDocFromDesired(dm) {
	const h = normalizeMemberHost(dm.host)
	const wantArbiter = dm.arbiterOnly === true
	if (dm._id === undefined || dm._id === null) {
		throw new Error("replica-set.json member missing _id for host " + h)
	}
	return {
		_id: dm._id,
		host: h,
		arbiterOnly: wantArbiter,
		votes: dm.votes !== undefined && dm.votes !== null ? dm.votes : 1,
		priority: dm.priority !== undefined && dm.priority !== null ? dm.priority : (wantArbiter ? 0 : 1),
	}
}

/**
 * Build the next replSet config document (does not apply it).
 * Preserves Mongo-assigned member _id for existing hosts so we never request an illegal _id change.
 */
function buildReconfigDocument(desired, current) {
	assertNoIllegalArbiterTransition(desired, current)
	const curByHost = currentMembersByHost(current)
	const mergedMembers = desired.members.map((dm) => {
		const h = normalizeMemberHost(dm.host)
		const cm = curByHost[h]
		if (cm) {
			return mergeLiveMemberWithDesired(dm, cm)
		}
		return newMemberDocFromDesired(dm)
	})
	const newConfig = {
		_id: desired._id,
		members: mergedMembers,
		version: current.version + 1,
	}
	if (current.settings !== undefined && current.settings !== null) {
		newConfig.settings = Object.assign({}, current.settings, desired.settings || {})
	}
	return newConfig
}

/**
 * Apply full desired config after incremental steps.
 */
function applyFullReconfig(desired) {
	const current = rs.conf()
	const newConfig = buildReconfigDocument(desired, current)
	rs.reconfig(newConfig, { force: false })
}

/**
 * Reconcile desired replica-set.json with live config (see file header for flows 1–4).
 */
function reconfigureReplicaSet() {
	const desired = JSON.parse(fs.readFileSync("/script/replica-set.json", "utf8"))
	if (!desired.members || !Array.isArray(desired.members)) {
		throw new Error("replica-set.json must contain a members array")
	}

	let current = rs.conf()

	print("[phase 0] Assert arbiter → data is not pending (manual procedure only)")
	assertArbiterToDataRequiresManual(desired, current)

	print("[phase 1] Cluster-wide default read/write concern")
	ensureClusterWideDefaultWriteConcern()
	current = rs.conf()

	print("[phase 2 / flow 2] Decommission: members not in desired (mongo removed from node)")
	removeMembersDroppedFromDesired(desired, current)
	current = rs.conf()

	print("[phase 3 / flow 4] Data → arbiter: rs.remove (then wipe dbPath, restart, phase 4 re-adds)")
	removeMembersForArbiterConversion(desired, current)
	current = rs.conf()

	print("[phase 4 / flows 1 & 3] Add new arbiter/peripheral or core data members")
	current = addMissingMembers(desired, current)

	print("[phase 5] rs.reconfig to align version/settings/tags")
	applyFullReconfig(desired)

	print("[phase 6] Sole data member: ensure a PRIMARY (e.g. after last arbiter removed)")
	ensurePrimaryWhenSoleDataMember(desired)
}

function initiateReplicaSet() {
	const newConfig = JSON.parse(fs.readFileSync("/script/replica-set.json", "utf8"))
	rs.initiate(newConfig)
}

function main() {
	print("mongo-init.js revision: asab-remote-control/remote_control/tech/mongo-init.js (2026-04-08c)")
	print("(Re)-initializing the Mongo cluster.")

	const mongoHostnames = process.env.MONGO_HOSTNAMES.split(",")

	for (let i = 0; i < 5; i++) {
		print("Connection attempt", i + 1)

		for (let hostname of mongoHostnames) {
			print("Connecting to ", `${hostname}:27017`)
			try {
				db = connect(`${hostname}:27017`)
			} catch (connectErr) {
				print("Failed with " + connectErr.name + ": " + connectErr.message)
				continue
			}

			const hello = db.hello()

			if (!hello.isWritablePrimary && !hello.secondary && hello.isreplicaset && hello.info === "Does not have a valid replica set config") {
				try {
					initiateReplicaSet()
					print("Initialization successful.")
					print("SUCCESS!")
					quit(0)
				} catch (e) {
					print("Initialization of replicaset failed.")
					print("Exiting due to failure.")
					quit(1)
				}
			}

			if (!hello.isWritablePrimary) {
				if (hello.secondary === true && hello.isreplicaset === true) {
					try {
						const conf = rs.conf()
						if (dataMemberCountFromConf(conf) === 1) {
							const st = rs.status()
							if (!rsStatusHasPrimary(st)) {
								print(
									"[recovery] one data member, no PRIMARY (e.g. arbiter decommissioned); replSetStepUp on " +
										`${hostname}:27017`
								)
								const up = db.adminCommand({ replSetStepUp: 1 })
								if (up.ok !== 1) {
									print("[recovery] replSetStepUp: " + JSON.stringify(up))
								}
								sleep(2000)
								const hello2 = db.hello()
								if (hello2.isWritablePrimary) {
									print("[recovery] became primary; running replica set reconcile")
									try {
										reconfigureReplicaSet()
										print("Successfully reconfigured replicaset.")
										print("SUCCESS!")
										quit(0)
									} catch (e) {
										print(
											"Reconfiguration failed with " +
												e.name +
												": " +
												e.message +
												" / " +
												(e.codeName != null ? e.codeName : "")
										)
										print("Exiting due to failure.")
										quit(1)
									}
								}
							}
						}
					} catch (recErr) {
						print("[recovery] skipped: " + recErr.message)
					}
				}
				print("Not a primary, continuing to the next Mongo node.")
				continue
			}

			print("This is a primary, reconfiguring a replicaset.")

			try {
				reconfigureReplicaSet()
				print("Successfully reconfigured replicaset.")
				print("SUCCESS!")
				quit(0)
			} catch (e) {
				print(
					"Reconfiguration failed with " +
						e.name +
						": " +
						e.message +
						" / " +
						(e.codeName != null ? e.codeName : "")
				)
				print("Exiting due to failure.")
				quit(1)
			}
		}
		sleep(5000)
	}
}

main()
