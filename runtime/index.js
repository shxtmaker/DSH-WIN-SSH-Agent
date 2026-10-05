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
//#endregion
//#region lib/types/index.js
/** Remote Linux instance discovery and authenticated identity route. */
/** Required Host services. */
const inject = ["connection", "webServer"];
/** Validated remote instance key. */
const Config = z.object({ instanceKey: z.string().required() });
/** Register an authenticated identity route and publish this boot's private descriptor after readiness. */
async function apply(ctx, config) {
	const { instanceKey } = config;
	const storage = await instanceStorage(ctx.profileContext.home, instanceKey);
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
	const publish = async () => {
		if (ctx.webServer.host !== "127.0.0.1") throw new Error("remote-companion: Web must bind loopback");
		const port = ctx.webServer.port;
		if (!Number.isInteger(port) || port < 1) throw new Error("remote-companion: Web listener unavailable");
		const descriptor = {
			protocolVersion: 1,
			instanceKey,
			instanceId: storage.instanceId,
			bootId,
			profile,
			workspaceHint,
			port,
			launchUrl: ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}/`)
		};
		await writeDescriptor(storage.descriptorPath, descriptor);
	};
	const ready = ctx.get("appReady");
	if (ready === void 0) await publish();
	else ctx.effect(() => ready.onReady(() => {
		publish().catch(() => {
			ctx.logger.error("remote-companion: descriptor publication failed");
		});
	}), "remote-companion: publish on application readiness");
	return async () => {
		await removeDescriptor(storage.descriptorPath, bootId);
	};
}
//#endregion
export { Config, apply, inject };
