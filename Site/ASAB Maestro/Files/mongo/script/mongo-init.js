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
 * Unsupported flows:
 * 1) Node role change (arbiter -> core)
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

function reachableVotingMemberCount() {
	let count = 0
	try {
		const st = rs.status()
		for (let i = 0; i < st.members.length; i++) {
			const m = st.members[i]
			const isHealthy = [1, 2, 3, 5].includes(m.state)
			if (isHealthy) {
				const conf = rs.conf()
				const memberConf = conf.members.find(cm => cm.host === m.name)
				if (memberConf && memberConf.arbiterOnly !== true) {
					count++
				}
			}
		}
	} catch (e) {
		print("[cwwc] could not determine reachable voting members: " + e.message)
	}
	return count
}

function ensureClusterWideDefaultWriteConcern() {
	const dwc = defaultWriteConcernFromEnv()
	const reachableCount = reachableVotingMemberCount()
	const wc = { w: "majority", wtimeout: 15000 }
	if (dwc.w === "majority" && reachableCount > 0) {
		const current = rs.conf()
		const totalVotingMembers = current.members.filter(m => m.votes > 0).length
		const majority = Math.floor(totalVotingMembers / 2) + 1
		if (majority > reachableCount) {
			print("[cwwc] majority=" + majority + " but only " + reachableCount + " reachable; using w=1 for setDefaultRWConcern")
			wc.w = 1
		}
	}
	const res = db.adminCommand({
		setDefaultRWConcern: 1,
		defaultWriteConcern: dwc,
		writeConcern: wc,
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
			hp + ". Last error: " + lastMsg
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

function desiredDataMemberCount(desired) {
	let n = 0
	for (const dm of desired.members) {
		if (dm.arbiterOnly !== true) {
			n++
		}
	}
	return n
}

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
			print("[sole data member] no PRIMARY yet (" + (k + 1) + "/" + maxPoll + "); sleeping " + ms + "ms")
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

function isMemberReachable(host) {
	try {
		const st = rs.status()
		for (let i = 0; i < st.members.length; i++) {
			if (normalizeMemberHost(st.members[i].name) === normalizeMemberHost(host)) {
				return st.members[i].health === 1
			}
		}
	} catch (e) {}
	return true
}

function forceReconfigToRemoveMembers(desired, current, toRemoveSet) {
	const hostsToRemove = Array.from(toRemoveSet)
	print("[force reconfig] Removing unreachable members via rs.reconfig({force:true}): " + hostsToRemove.join(", "))
	const filtered = current.members.filter(function(m) {
		const h = normalizeMemberHost(m.host)
		return !toRemoveSet.has(h)
	})
	if (filtered.length === 0) {
		throw new Error("Force reconfig would remove ALL members — refusing (need at least 1 data member)")
	}
	let hasData = false
	for (let i = 0; i < filtered.length; i++) {
		if (filtered[i].arbiterOnly !== true) {
			hasData = true
			break
		}
	}
	if (!hasData) {
		throw new Error("Force reconfig would remove all data-bearing members — refusing")
	}
	const newConfig = {
		_id: current._id,
		members: filtered,
		version: current.version + 1,
		protocolVersion: current.protocolVersion !== undefined ? current.protocolVersion : 1,
	}
	if (current.settings !== undefined && current.settings !== null) {
		newConfig.settings = Object.assign({}, current.settings)
	}
	const result = rs.reconfig(newConfig, {force: true})
	print("[force reconfig] ok=" + result.ok + " (new version=" + newConfig.version + ")")
}

function removeMembersDroppedFromDesired(desired, current) {
	if (desiredDataMemberCount(desired) < 1) {
		throw new Error("replica-set.json must keep at least one data (non-arbiter) member")
	}
	const wantHosts = desiredHostSet(desired)
	const selfH = connectedMemberHost()
	const toRemoveReachable = []
	const toRemoveUnreachable = new Set()
	for (const cm of current.members) {
		const h = normalizeMemberHost(cm.host)
		if (!wantHosts.has(h)) {
			if (selfH !== null && h === selfH) {
				throw new Error(
					"Desired config omits the current primary host (" + h +
					"). Step down another primary first, or keep this member in replica-set.json until then."
				)
			}
			if (isMemberReachable(h)) {
				toRemoveReachable.push(h)
			} else {
				toRemoveUnreachable.add(h)
			}
		}
	}
	for (let i = 0; i < toRemoveReachable.length; i++) {
		const h = toRemoveReachable[i]
		print("[flow 2 decommission] Removing reachable member: " + h)
		try {
			rs.remove(h)
			current = rs.conf()
		} catch (e) {
			print("rs.remove failed (will handle via force reconfig): " + e.message)
			toRemoveUnreachable.add(h)
		}
	}
	if (toRemoveUnreachable.size > 0) {
		current = rs.conf()
		forceReconfigToRemoveMembers(desired, current, toRemoveUnreachable)
	}
}

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
			if (currentMembersByHost(rs.conf())[h]) {
				if (t > 1) print("rs.add: " + h + " already in config, continuing")
				return
			}
		} catch (_) {}
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
			const errText = String((err.message || "") + " " + (err.codeName || ""))
			if (/already exists|already in config/i.test(errText)) {
				try {
					if (currentMembersByHost(rs.conf())[h]) {
						print("rs.add: " + h + " already in config, continuing")
						return
					}
				} catch (_) {}
			}
			const retryable =
				t < maxTry &&
				/Quorum check failed|Connection refused|NodeNotFound|timed out|Timeout|ConfigurationInProgress/i.test(errText)
			if (retryable) {
				print("rs.add retry " + t + "/" + maxTry + ": " + err.message)
				sleep(delay)
				continue
			}
			throw err
		}
	}
}

function assertArbiterToDataRequiresManual(desired, current) {
	const curMap = currentMembersByHost(current)
	const offenders = []
	for (const dm of desired.members) {
		const h = normalizeMemberHost(dm.host)
		const cm = curMap[h]
		if (!cm) continue
		const wantArbiter = dm.arbiterOnly === true
		const wantData = dm.arbiterOnly === false
		const isArbiter = cm.arbiterOnly === true
		if (isArbiter && wantData) {
			offenders.push(h)
		}
	}
	if (offenders.length === 0) return
	throw new Error(
		"Refusing init: arbiter → data promotion is manual-only for: " +
			offenders.join(", ") +
			". Do this, then re-run init: (1) On PRIMARY: rs.remove(\"host:port\") for each host above. " +
			"(2) On each former arbiter host: stop mongod, delete ALL files under dbPath, start mongod empty. " +
			"(3) Re-run init."
	)
}

function removeMembersForArbiterConversion(desired, current) {
	const curMap = currentMembersByHost(current)
	let removed = false
	for (const dm of desired.members) {
		const h = normalizeMemberHost(dm.host)
		const cm = curMap[h]
		if (cm && dm.arbiterOnly === true && cm.arbiterOnly !== true) {
			print("[flow 4 data→arbiter] Removing data member for arbiter conversion: " + h)
			print("ACTION: stop mongod, EMPTY the full dbPath, restart.")
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
					print("[flow 3 PSA] one data + arbiter: rs.reconfigForPSASet")
					if (typeof rs.reconfigForPSASet !== "function") {
						throw new Error("rs.reconfigForPSASet is not available in this shell.")
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

function assertNoIllegalArbiterTransition(desired, current) {
	const curMap = currentMembersByHost(current)
	for (const dm of desired.members) {
		const h = normalizeMemberHost(dm.host)
		const cm = curMap[h]
		if (!cm) continue
		if (dm.arbiterOnly === undefined || dm.arbiterOnly === null) continue
		const wantArbiter = dm.arbiterOnly === true
		const isArbiter = cm.arbiterOnly === true
		if (isArbiter !== wantArbiter) {
			throw new Error(
				"Refusing rs.reconfig: cannot change arbiterOnly in place for " + h +
				" (live arbiterOnly=" + isArbiter + ", desired=" + wantArbiter +
				"). Remove member, wipe dbPath, restart mongod, then re-run init."
			)
		}
	}
}

function mergeLiveMemberWithDesired(dm, cm) {
	const out = Object.assign({}, cm)
	out.host = normalizeMemberHost(dm.host)
	if (dm.arbiterOnly !== undefined && dm.arbiterOnly !== null) {
		out.arbiterOnly = dm.arbiterOnly === true
	}
	if (dm.priority !== undefined) out.priority = dm.priority
	if (dm.votes !== undefined) out.votes = dm.votes
	if (dm.tags !== undefined) out.tags = dm.tags
	if (dm.secondaryDelaySecs !== undefined) out.secondaryDelaySecs = dm.secondaryDelaySecs
	if (out.votes === undefined || out.votes === null) out.votes = 1
	const isArbiter = out.arbiterOnly === true
	if (out.priority === undefined || out.priority === null) out.priority = isArbiter ? 0 : 1
	return out
}

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

function buildReconfigDocument(desired, current) {
	assertNoIllegalArbiterTransition(desired, current)
	const curByHost = currentMembersByHost(current)
	const mergedMembers = desired.members.map((dm) => {
		const h = normalizeMemberHost(dm.host)
		const cm = curByHost[h]
		return cm ? mergeLiveMemberWithDesired(dm, cm) : newMemberDocFromDesired(dm)
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

function applyFullReconfig(desired) {
	const maxRetries = parseInt(process.env.MONGO_INIT_RECONFIG_ATTEMPTS || "3", 10)
	const retryMs = parseInt(process.env.MONGO_INIT_RECONFIG_DELAY_MS || "5000", 10)
	const maxTry = isNaN(maxRetries) ? 3 : Math.max(1, maxRetries)
	const delay = isNaN(retryMs) ? 5000 : Math.max(1000, retryMs)
	for (let t = 1; t <= maxTry; t++) {
		const current = rs.conf()
		const newConfig = buildReconfigDocument(desired, current)
		try {
			rs.reconfig(newConfig, { force: false })
			if (t > 1) print("[phase 5] succeeded on retry " + t)
			return
		} catch (e) {
			const msg = (e.message || "") + " " + (e.codeName || "")
			if (t < maxTry && /ConfigurationInProgress|NewReplicaSetConfigurationIncompatible/i.test(msg)) {
				print("[phase 5] retry " + t + "/" + maxTry + ": " + e.message + " in " + delay + "ms")
				sleep(delay)
			} else {
				throw e
			}
		}
	}
}

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

function isTransientConfigError(e) {
	const msg = (e.message || "") + " " + (e.codeName || "")
	return /MongoServerSelectionError|MongoNetworkError|ConfigurationInProgress|NewReplicaSetConfigurationIncompatible|already exists|already in config/i.test(msg)
}

function main() {
	print("mongo-init.js revision: asab-remote-control/remote_control/tech/mongo-init.js (2026-06-22d — concurrent-init race fixed)")
	print("(Re)-initializing the Mongo cluster.")

	const mongoHostnames = process.env.MONGO_HOSTNAMES.split(",")

	const bootAttempts = parseInt(process.env.MONGO_INIT_BOOT_ATTEMPTS || "60", 10)
	const bootMs = parseInt(process.env.MONGO_INIT_BOOT_MS || "3000", 10)
	const maxBoot = isNaN(bootAttempts) ? 60 : Math.max(1, bootAttempts)
	const bootDelay = isNaN(bootMs) ? 3000 : Math.max(1000, bootMs)
	const pending = new Set(mongoHostnames.map(h => normalizeMemberHost(h)))
	for (let a = 1; a <= maxBoot; a++) {
		for (const hn of Array.from(pending)) {
			const hp = hn + ":27017"
			try {
				if (typeof Mongo !== "undefined") {
					const conn = new Mongo(hp)
					if (conn.getDB("admin").runCommand({ ping: 1 }).ok === 1) {
						pending.delete(hn)
						print("[boot] mongod reachable: " + hp)
					}
				}
			} catch (_) {}
		}
		if (pending.size === 0) {
			print("[boot] all mongods reachable after " + a + "/" + maxBoot + " attempts")
			break
		}
		if (a < maxBoot) {
			print("[boot] " + pending.size + "/" + mongoHostnames.length + " down (" + Array.from(pending).join(", ") + ") — " + a + "/" + maxBoot)
			sleep(bootDelay)
		}
	}
	if (pending.size > 0) {
		print("[boot] WARNING: timed out; still down: " + Array.from(pending).join(", "))
	}

	const maxMain = parseInt(process.env.MONGO_INIT_MAIN_ATTEMPTS || "20", 10)
	const maxMainSafe = isNaN(maxMain) ? 20 : Math.max(1, maxMain)

	for (let i = 0; i < maxMainSafe; i++) {
		print("Connection attempt " + (i + 1) + "/" + maxMainSafe)

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
								print("[recovery] one data member, no PRIMARY; replSetStepUp on " + `${hostname}:27017`)
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
										if (isTransientConfigError(e)) {
											print("[recovery] transient error (" + e.message + "), will retry.")
											break
										}
										print("Reconfiguration failed with " + e.name + ": " + e.message + " / " + (e.codeName || ""))
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
				if (isTransientConfigError(e)) {
					print("[reconfig] transient error (" + e.message + "), will retry on next attempt.")
					break
				}
				print("Reconfiguration failed with " + e.name + ": " + e.message + " / " + (e.codeName || ""))
				print("Exiting due to failure.")
				quit(1)
			}
		}
		sleep(5000)
	}

	print("All connection attempts exhausted (" + maxMainSafe + " × 5s = " + (maxMainSafe * 5) + "s), no primary reachable.")
	quit(1)
}

main()
