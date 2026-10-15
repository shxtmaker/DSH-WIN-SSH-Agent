import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { getDshRuntimeVersion } from "@deepseek-ai/dsh-app-boot";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
//#region lib/types/private-files.js
/** Linux-only private instance identity and launch-descriptor storage. */
const KEY = /^[A-Za-z0-9_-]{1,64}$/u;
function isMissing(error) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
async function privateDirectory(path, isHome = false) {
	try {
		await mkdir(path, { mode: 448 });
	} catch (error) {
		if (!isMissing(error) && !(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
	}
	const info = await lstat(path);
	const unsafe = () => /* @__PURE__ */ new Error(`remote-companion: unsafe private directory: ${path}`);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 2) !== 0) throw unsafe();
	const unsafeBits = isHome ? 18 : 63;
	if ((info.mode & unsafeBits) === 0) return;
	const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const opened = await directory.stat();
		if (!opened.isDirectory() || opened.uid !== process.getuid?.() || opened.dev !== info.dev || opened.ino !== info.ino || (opened.mode & 2) !== 0) throw unsafe();
		await directory.chmod(opened.mode & 511 & ~unsafeBits);
		const current = await lstat(path);
		if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== opened.uid || current.dev !== opened.dev || current.ino !== opened.ino || (current.mode & unsafeBits) !== 0) throw unsafe();
	} finally {
		await directory.close();
	}
}
async function privateFile(path) {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 63) !== 0) throw new Error("remote-companion: unsafe private file");
		return true;
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
}
/** Prepare private directories and load or create one stable instance id. */
async function instanceStorage(home, instanceKey) {
	if (process.platform !== "linux" || !KEY.test(instanceKey)) throw new Error("remote-companion: Linux and a valid instance key are required");
	await privateDirectory(home, true);
	const root = join(home, "remote-workspace");
	await privateDirectory(root);
	const run = join(root, "run");
	await privateDirectory(run);
	const idPath = join(root, `instance-${instanceKey}.id`);
	if (!await privateFile(idPath)) {
		const file = await open(idPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
		try {
			await file.writeFile(randomUUID() + "\n");
			await file.sync();
		} finally {
			await file.close();
		}
	}
	const instanceId = (await readFile(idPath, "utf8")).trim();
	if (!/^[0-9a-f-]{36}$/u.test(instanceId)) throw new Error("remote-companion: invalid stable instance id");
	return {
		instanceId,
		descriptorPath: join(run, `${instanceKey}.json`)
	};
}
/** Atomically replace only a safe descriptor with a private temporary file. */
async function writeDescriptor(path, value) {
	await privateFile(path);
	const temporary = `${path}.${randomUUID()}.tmp`;
	const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
	try {
		await file.writeFile(JSON.stringify(value) + "\n");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary);
		throw error;
	}
}
/** Delete only the file still naming this process's boot generation. */
async function removeDescriptor(path, bootId) {
	if (!await privateFile(path)) return;
	const value = JSON.parse(await readFile(path, "utf8"));
	if (typeof value === "object" && value !== null && "bootId" in value && value.bootId === bootId) await unlink(path);
}
/**
* Return whether the stored descriptor still exists, stays private, and names
* this running boot. A plugin reload, a plugin-manager run, an operator or any
* other instance can remove or replace the file while this process keeps
* running; the caller republishes whenever this check fails.
*/
async function descriptorMatches(path, expected) {
	try {
		if (!await privateFile(path)) return false;
		const value = JSON.parse(await readFile(path, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const row = value;
		return row.bootId === expected.bootId && row.instanceId === expected.instanceId && row.port === expected.port && typeof row.launchUrl === "string" && row.launchUrl.length > 0;
	} catch {
		return false;
	}
}
//#endregion
//#region lib/types/self-heal.js
/** Idempotent repair loop for private state that another activation can delete. */
/**
* Run `ensure` on a fixed interval and return the disposer that stops it.
* Attempts never overlap, a rejected attempt does not stop later ones, and a
* disposed activation stops writing even before the timer is cleared. The
* timer is unref'ed so a short-lived profile load, such as a plugin-manager
* run, still exits on its own.
*/
function startSelfHeal(options) {
	let pending;
	const attempt = () => {
		if (options.isDisposed() || pending !== void 0) return;
		pending = options.ensure().catch((error) => {
			options.onError(error);
		}).finally(() => {
			pending = void 0;
		});
	};
	const timer = setInterval(attempt, options.intervalMs);
	timer.unref();
	return () => {
		clearInterval(timer);
	};
}
//#endregion
//#region lib/types/index.js
/** Remote Linux instance discovery and authenticated identity route. */
/** Milliseconds between descriptor repairs. A plugin reload or a plugin-manager
* run against the same profile disposes this activation and deletes the file,
* and the replacement activation only republishes when it reaches readiness. */
const REPAIR_INTERVAL_MS = 5e3;
/** Required Host services. */
const inject = ["connection", "webServer"];
/** Validated remote instance key. */
const Config = z.object({ instanceKey: z.string().required() });
/**
* Register an authenticated identity route and keep this boot's private
* descriptor present for as long as the process runs: publish at activation,
* publish again on application readiness, and repair any later removal or
* replacement from another activation. The restricted helper reads only this
* file, so a missing descriptor makes every connection attempt fail until the
* running Web process is restarted when no repair loop exists.
*/
async function apply(ctx, config) {
	const { instanceKey } = config;
	const home = ctx.profileContext.home;
	const storage = await instanceStorage(home, instanceKey);
	const bootId = randomUUID();
	const profile = ctx.profileContext.name;
	const workspaceHint = ctx.profileContext.cwd;
	const identity = {
		protocolVersion: 1,
		instanceKey,
		instanceId: storage.instanceId,
		bootId,
		profile,
		workspaceHint,
		version: getDshRuntimeVersion(),
		capabilities: ["web", "remote.mux"]
	};
	ctx.effect(() => ctx.connection.fetch.register({
		path: "/api/remote-workspace/identity",
		methods: ["GET"],
		requestBody: "buffered",
		fetch: () => Promise.resolve(new Response(JSON.stringify(identity), {
			status: 200,
			headers: {
				"content-type": "application/json",
				"cache-control": "no-store"
			}
		}))
	}), "remote-companion: authenticated identity");
	let disposed = false;
	let reported = "";
	const report = (error) => {
		const message = error instanceof Error ? error.message : String(error);
		if (message === reported) return;
		reported = message;
		ctx.logger.warn(`remote-companion: descriptor repair failed: ${message}`);
	};
	const publish = async () => {
		const current = await instanceStorage(home, instanceKey);
		if (ctx.webServer.host !== "127.0.0.1") throw new Error(`remote-companion: Web must bind loopback, not ${ctx.webServer.host}`);
		const port = ctx.webServer.port;
		if (!Number.isInteger(port) || port < 1) throw new Error("remote-companion: Web listener unavailable");
		if (await descriptorMatches(current.descriptorPath, {
			bootId,
			instanceId: current.instanceId,
			port
		})) return;
		const descriptor = {
			protocolVersion: 1,
			instanceKey,
			instanceId: current.instanceId,
			bootId,
			profile,
			workspaceHint,
			port,
			launchUrl: ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}/`)
		};
		await writeDescriptor(current.descriptorPath, descriptor);
		reported = "";
	};
	const ready = ctx.get("appReady");
	if (ready === void 0) await publish();
	else {
		await publish().catch(() => void 0);
		ctx.effect(() => ready.onReady(() => {
			publish().catch(report);
		}), "remote-companion: publish on application readiness");
	}
	const stop = startSelfHeal({
		intervalMs: REPAIR_INTERVAL_MS,
		ensure: publish,
		onError: report,
		isDisposed: () => disposed
	});
	ctx.effect(() => stop, "remote-companion: descriptor repair loop");
	return async () => {
		disposed = true;
		stop();
		await removeDescriptor(storage.descriptorPath, bootId);
	};
}
//#endregion
export { Config, REPAIR_INTERVAL_MS, apply, inject };
